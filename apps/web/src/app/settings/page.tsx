import { headers } from "next/headers";
import { requireProfile } from "@/lib/auth";
import SettingsForm from "@/components/SettingsForm";

export default async function SettingsPage() {
  // Next 15: headers() is a promise.
  const headerList = await headers();
  const authHeader = headerList.get("authorization");
  const request = new Request("http://localhost", {
    headers: { Authorization: authHeader || "" },
  });

  const profile = await requireProfile(request);

  return (
    <main className="shell">
      <h1>Settings</h1>

      <section className="card">
        <h2>Public profile</h2>
        <p>
          Your username is your public handle. It is what other people see and
          what your profile link uses. Your email address is never shown to
          anyone.
        </p>
        <SettingsForm
          initialUsername={profile.username}
          initialDisplayName={profile.display_name}
          initialAvatarPath={profile.avatar_path}
          initialShareTaskTitles={profile.share_task_titles}
        />
      </section>
    </main>
  );
}
