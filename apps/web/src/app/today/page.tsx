import { headers } from "next/headers";
import { getActiveFriends } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  // Next 15: headers() is a promise; build the request the auth helpers read.
  const headerList = await headers();
  const request = new Request("http://localhost", {
    headers: { Authorization: headerList.get("authorization") || "" },
  });

  const activeFriends = await getActiveFriends(request);

  return (
    <main>
      <h1>Today's Activities</h1>
      <section>
        <h2>Friends with Active Sessions</h2>
        {activeFriends.length > 0 ? (
          <ul>
            {activeFriends.map((friend) => (
              <li key={friend.id}>
                {friend.avatar_url && (
                  <img
                    src={friend.avatar_url}
                    alt={friend.display_name || friend.username || "Friend"}
                    width={24}
                    height={24}
                  />
                )}
                <span>{friend.display_name || friend.username}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No friends with active sessions.</p>
        )}
      </section>
    </main>
  );
}
