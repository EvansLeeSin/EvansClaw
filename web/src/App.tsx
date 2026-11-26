import { useEffect, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { RoomView } from "@/components/room/room-view";

/** 极简 hash 路由：#/room 为多人聊天室，其余为个人助手。 */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  return hash.startsWith("#/room") ? <RoomView /> : <ChatView />;
}
