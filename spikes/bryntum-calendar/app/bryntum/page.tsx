import { BryntumSpike } from "../../src/loaders";

type Props = { searchParams: Promise<{ theme?: string }> };

export default async function BryntumPage({ searchParams }: Props) {
  const scheme = (await searchParams).theme === "dark" ? "dark" : "light";
  return (
    <div className={scheme === "dark" ? "dark" : undefined}>
      <main>
        <h1>Expected releases · Bryntum Calendar 7.3.8 (trial)</h1>
        <BryntumSpike colorScheme={scheme} />
      </main>
    </div>
  );
}
