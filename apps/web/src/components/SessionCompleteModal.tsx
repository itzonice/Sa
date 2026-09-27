"use client";

import React from "react";
import { track, EVENTS } from "@/lib/analytics";

interface SessionCompleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  recapData: {
    course_name: string;
    actualMinutes: number;
    completionPercent: number;
    note: string | null;
    shareLink: string; // Placeholder for the share link
  };
}

export default function SessionCompleteModal({
  isOpen,
  onClose,
  recapData,
}: SessionCompleteModalProps) {
  if (!isOpen) return null;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(recapData.shareLink);
    alert("Share link copied to clipboard!");
    track(EVENTS.share_card_created, { method: "copy_link" });
  };

  const handleWebShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Study Session Recap: ${recapData.course_name}`,
          text: `I just completed a ${recapData.actualMinutes} minute study session for ${recapData.course_name} with ${recapData.completionPercent}% completion! Check it out: `,
          url: recapData.shareLink,
        });
        track(EVENTS.share_card_created, { method: "web_share" });
        console.log("Web Share successful");
      } catch (error) {
        console.error("Web Share failed:", error);
      }
    } else {
      alert("Web Share not supported in this browser. Link copied to clipboard instead.");
      handleCopyLink();
      track(EVENTS.share_card_created, { method: "web_share_fallback_copy_link" });
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          backgroundColor: "white",
          padding: "20px",
          borderRadius: "8px",
          maxWidth: "500px",
          width: "100%",
          boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
        }}
      >
        <h2>Session Complete!</h2>
        <h3>Recap for {recapData.course_name}</h3>
        <p>Actual Minutes: {recapData.actualMinutes}</p>
        <p>Completion: {recapData.completionPercent}%</p>
        {recapData.note && <p>Notes: {recapData.note}</p>}

        <div style={{ marginTop: "20px" }}>
          <button onClick={handleCopyLink} style={{ marginRight: "10px" }}>
            Copy Share Link
          </button>
          <button onClick={handleWebShare}>Share via Web Share</button>
        </div>

        <button onClick={onClose} style={{ marginTop: "20px", display: "block" }}>
          Close
        </button>
      </div>
    </div>
  );
}
