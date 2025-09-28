import React from 'react';
import VideoCall from './VideoCall';

export default function App() {
  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif' }}>
      <h1>WebRTC Video Call (React + Spring Boot signaling)</h1>
      <VideoCall />
    </div>
  );
}
