"use client";

import React, { useState } from "react";
import SessionCompleteModal from "../../components/SessionCompleteModal";

export default function LiveSessionPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [recapData, setRecapData] = useState({
    course_name: "Calculus I",
    actualMinutes: 60,
    completionPercent: 85,
    note: "Reviewed derivatives and integrals.",
    shareLink: "", // Will be populated after API call
  });

  const openModal = async () => {
    // In a real app, this data would come from the completed session
    const sessionData = {
      course_name: "Calculus I",
      actualMinutes: 60,
      completionPercent: 85,
      note: "Reviewed derivatives and integrals.",
    };

    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Assuming authentication token is handled by Next.js session or similar
          // If not, you might need to pass it from client-side session
        },
        body: JSON.stringify({
          kind: "session",
          payload: {
            course_name: sessionData.course_name,
            minutes: sessionData.actualMinutes,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create share card: ${errorText}`);
      }

      const { url } = await response.json();
      setRecapData({ ...sessionData, shareLink: window.location.origin + url });
      setIsModalOpen(true);
    } catch (error) {
      console.error("Error creating share card:", error);
      alert("Failed to create share card. Please try again.");
    }
  };

  const closeModal = () => setIsModalOpen(false);

  return (
    <main>
      <h1>Live Session</h1>
      <p>This is a placeholder for the live session page content.</p>
      <button onClick={openModal}>Simulate Session Complete</button>

      <SessionCompleteModal isOpen={isModalOpen} onClose={closeModal} recapData={recapData} />
    </main>
  );
}
