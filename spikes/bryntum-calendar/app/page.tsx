import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>M0-09 calendar spike</h1>
      <ul>
        <li>
          <Link href="/bryntum">Bryntum Calendar (trial)</Link> · <Link href="/bryntum?theme=dark">dark</Link>
        </li>
        <li>
          <Link href="/fullcalendar">FullCalendar 7</Link> · <Link href="/fullcalendar?theme=dark">dark</Link>
        </li>
      </ul>
    </main>
  );
}
