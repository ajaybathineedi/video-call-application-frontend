import React, { useRef, useState, useEffect } from "react";

/*
  Improved VideoCall.jsx with WebSocket readiness checks and safer startCall().
  Use: Put this in src/VideoCall.jsx and run the frontend as before.
*/

export default function VideoCall() {
  const [myId, setMyId] = useState(() => `user${Math.floor(Math.random() * 10000)}`);
  const [peerId, setPeerId] = useState("");
  const [connected, setConnected] = useState(false); // websocket joined ack received
  const [wsStatus, setWsStatus] = useState("closed"); // "opening" | "open" | "closed"
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line
  }, []);

  function log(...args) {
    console.log("[VideoCall]", ...args);
  }

  async function startLocalStream() {
    if (localStreamRef.current) return localStreamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = s;
    if (localVideoRef.current) localVideoRef.current.srcObject = s;
    return s;
  }

  function ensureWsOpen() {
    // returns a promise that resolves when WebSocket is open (readyState === 1)
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws) return reject(new Error("WebSocket not initialized"));
      if (ws.readyState === WebSocket.OPEN) return resolve();
      if (ws.readyState === WebSocket.CONNECTING) {
        const onOpen = () => {
          ws.removeEventListener("open", onOpen);
          resolve();
        };
        const onClose = () => {
          ws.removeEventListener("open", onOpen);
          reject(new Error("WebSocket closed before opening"));
        };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("close", onClose);
        // optional: add a timeout
        setTimeout(() => {
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("close", onClose);
          if (ws.readyState === WebSocket.OPEN) resolve();
          else reject(new Error("Timed out waiting for WebSocket to open"));
        }, 5000);
      } else {
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  function connect() {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      log("WebSocket already connecting/open");
      return;
    }
    const ws = new WebSocket("ws://localhost:8080/signal");
    wsRef.current = ws;
    setWsStatus("opening");

    ws.addEventListener("open", () => {
      log("WS open, sending join", myId);
      setWsStatus("open");
      try {
        ws.send(JSON.stringify({ type: "join", from: myId }));
      } catch (e) {
        console.error("Failed to send join", e);
      }
    });

    ws.addEventListener("message", async (evt) => {
      const msg = JSON.parse(evt.data);
      log("WS message", msg);

      if (msg.type === "joined") {
        setConnected(true);
        log("Joined acknowledged by server");
        return;
      }

      if (msg.type === "offer") {
        await ensurePc();
        try {
          await pcRef.current.setRemoteDescription(msg.sdp);
        } catch (e) {
          console.error("setRemoteDescription(offer) failed", e);
          return;
        }
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        try {
          await ensureWsOpen();
          wsRef.current.send(JSON.stringify({ type: "answer", from: myId, to: msg.from, sdp: pcRef.current.localDescription }));
          log("Sent answer");
        } catch (e) {
          console.error("Cannot send answer - WS not ready", e);
        }
      } else if (msg.type === "answer") {
        try {
          await pcRef.current.setRemoteDescription(msg.sdp);
          log("Set remote answer");
        } catch (e) {
          console.error("setRemoteDescription(answer) failed", e);
        }
      } else if (msg.type === "candidate") {
        try {
          await pcRef.current.addIceCandidate(msg.candidate);
        } catch (e) {
          console.warn("addIceCandidate error", e);
        }
      } else if (msg.type === "error") {
        console.warn("Signaling error", msg.message);
      }
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setWsStatus("closed");
      log("WS closed");
    });

    ws.addEventListener("error", (e) => {
      console.error("WS error", e);
      setWsStatus("closed");
    });
  }

  async function ensurePc() {
    if (pcRef.current) return;
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      // add TURN server here if you have it
    ];
    const pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        if (!peerId) {
          console.warn("No peerId set; not sending candidate");
          return;
        }
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          console.warn("WS not open; cannot send candidate yet");
          return;
        }
        try {
          wsRef.current.send(JSON.stringify({ type: "candidate", from: myId, to: peerId, candidate: ev.candidate }));
        } catch (e) {
          console.error("Failed to send candidate", e);
        }
      }
    };

    pc.ontrack = (ev) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = ev.streams[0];
    };

    const localStream = await startLocalStream();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pcRef.current = pc;
  }

  async function startCall() {
    try {
      if (!peerId) {
        alert("Please enter a Peer ID (the other user's My ID).");
        return;
      }

      // Ensure websocket exists and is open; if not, try to connect and wait for it
      if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
        log("WebSocket not present or closed — initiating connect()");
        connect();
      }

      // wait for open (or reject after timeout)
      await ensureWsOpen();
      if (!connected) {
        // we sent join on open; wait briefly for server ack of 'joined' (optional)
        // but even without ack, WS open is enough to send signaling messages
        log("WS open; proceeding to create offer");
      }

      await ensurePc();
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);

      // Final check before sending
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open (cannot send offer)");
      }

      wsRef.current.send(JSON.stringify({ type: "offer", from: myId, to: peerId, sdp: pcRef.current.localDescription }));
      log("Sent offer to", peerId);
    } catch (err) {
      console.error("startCall failed:", err);
      alert("Failed to start call: " + (err.message || err));
    }
  }

  function cleanup() {
    if (pcRef.current) {
      try {
        pcRef.current.getSenders().forEach((s) => {
          try {
            s.track?.stop();
          } catch (e) {}
        });
        pcRef.current.close();
      } catch (e) {
        console.warn("Error closing pc", e);
      }
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnected(false);
    setWsStatus("closed");
  }

  function hangup() {
    cleanup();
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <label>My ID: </label>
        <input value={myId} onChange={(e) => setMyId(e.target.value)} style={{ marginRight: 10 }} />
        <button onClick={connect} disabled={wsStatus === "opening" || wsStatus === "open"}>
          Connect
        </button>
        <button onClick={hangup} style={{ marginLeft: 6 }}>
          Hangup
        </button>
        <span style={{ marginLeft: 12 }}>WS: {wsStatus} | Joined: {connected ? "yes" : "no"}</span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label>Peer ID: </label>
        <input value={peerId} onChange={(e) => setPeerId(e.target.value)} style={{ marginRight: 10 }} />
        <button onClick={startCall} disabled={wsStatus !== "open"}>
          Call
        </button>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <div>
          <div>Local</div>
          <video ref={localVideoRef} autoPlay muted playsInline style={{ width: 240, border: "1px solid #ddd" }} />
        </div>

        <div>
          <div>Remote</div>
          <video ref={remoteVideoRef} autoPlay playsInline style={{ width: 480, border: "1px solid #ddd" }} />
        </div>
      </div>
    </div>
  );
}
