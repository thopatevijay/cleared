import { site } from "../src/lib/site.ts";

export default function Home() {
  return (
    <main>
      <h1>{site.name}</h1>
      <p>{site.tagline}</p>
    </main>
  );
}
