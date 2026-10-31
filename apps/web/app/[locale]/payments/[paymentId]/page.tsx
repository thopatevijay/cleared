// `/payments/[paymentId]` opens the payment's proof pack (payment-detail.md: the route redirects to it).
import { redirect } from "next/navigation";

export default async function PaymentPage({
  params,
}: {
  params: Promise<{ locale: string; paymentId: string }>;
}) {
  const { locale, paymentId } = await params;
  redirect(`/${locale}/payments/${encodeURIComponent(paymentId)}/pack`);
}
