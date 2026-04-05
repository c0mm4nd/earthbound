import { Suspense } from "react";
import { BridgeApp } from "@/components/bridge-app";

export default function Home() {
  return (
    <Suspense>
      <BridgeApp />
    </Suspense>
  );
}
