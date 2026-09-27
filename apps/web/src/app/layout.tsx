import type { Metadata } from "next";
import "../styles/globals.css";
import { AnalyticsProvider } from "../lib/analytics";

export const metadata: Metadata = {
  title: "Studyly",
  description: "Know what to study next.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AnalyticsProvider>{children}</AnalyticsProvider>
      </body>
    </html>
  );
}
