// The pack page's loading state while the server reads the pack (payment-detail.md "States").
import { PackLoading } from "../../../../../src/components/pack/PackLoading.tsx";

export default function Loading() {
  return (
    <main id="main" className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 xl:max-w-[1200px]">
      <PackLoading />
    </main>
  );
}
