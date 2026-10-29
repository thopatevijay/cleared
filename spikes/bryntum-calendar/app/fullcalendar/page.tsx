import { FullCalendarSpike } from "../../src/loaders";

type Props = { searchParams: Promise<{ theme?: string }> };

export default async function FullCalendarPage({ searchParams }: Props) {
  const scheme = (await searchParams).theme === "dark" ? "dark" : "light";
  return (
    <div className={scheme === "dark" ? "dark" : undefined}>
      <main>
        <h1>Expected releases · FullCalendar 7.1.3</h1>
        <FullCalendarSpike colorScheme={scheme} />
      </main>
    </div>
  );
}
