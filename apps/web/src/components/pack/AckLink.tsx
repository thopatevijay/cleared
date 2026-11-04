"use client";
// The seller's "Client acknowledgement" panel on the proof pack (client-ack.md, M3-06): create a one-time
// link for the pack's current scope item, copy it (shown only right after creation: the server keeps a
// hash), revoke it, and see pending / accepted / expired / revoked / scope changed. Polls while pending and
// announces an acceptance once.
import type { AckLinkStatus, AckLinkView } from "@cleared/core";
import { CircleCheck, CircleDashed, Clock, LoaderCircle, Lock, X, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { type ApiResult, getParsed, loadSchemas, postJson } from "../../lib/api.ts";
import { formatTime } from "../../lib/format.ts";
import { useOnline } from "../../lib/use-online.ts";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { openEvidence } from "./Citation.tsx";

const POLL_MS = 5_000;
const BADGE: Record<AckLinkStatus, { icon: LucideIcon; pill: string }> = {
  pending: { icon: Clock, pill: "bg-status-info-bg text-status-info-fg" },
  accepted: { icon: CircleCheck, pill: "bg-status-completed-bg text-status-completed-fg" },
  expired: { icon: Lock, pill: "bg-status-neutral-bg text-status-neutral-fg" },
  revoked: { icon: X, pill: "bg-status-neutral-bg text-status-neutral-fg" },
  scope_changed: { icon: CircleDashed, pill: "bg-status-held-bg text-status-held-fg" },
};
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 font-medium disabled:opacity-60";

type Link = NonNullable<AckLinkView["link"]>;
type Failure = { readonly what: "create" | "revoke"; readonly reference: string | null };

function Badge({ status }: { status: AckLinkStatus }) {
  const t = useTranslations("pack.ack.status");
  const { icon: Icon, pill } = BADGE[status];
  return (
    <span
      className={`inline-flex h-6 items-center gap-1 self-start rounded-pill px-2 text-sm font-medium ${pill}`}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
      {t(status)}
    </span>
  );
}

function useDates(timeZone: string) {
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  return {
    day: (iso: string) =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone,
        numberingSystem: "latn",
      }).format(new Date(iso)),
    time: (iso: string) => formatTime(locale, iso, timeZone),
  };
}

function CopyBox({ url, onCopied }: { url: string; onCopied: (ok: boolean) => void }) {
  const t = useTranslations("pack.ack");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      onCopied(true);
    } catch {
      input.current?.select();
      onCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-end">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium">{t("linkLabel")}</span>
        <input
          ref={input}
          readOnly
          value={url}
          onFocus={(e) => {
            e.currentTarget.select();
            // read from "https://", not from wherever the selection scrolled to
            e.currentTarget.scrollLeft = 0;
          }}
          data-testid="ack-url"
          className="min-h-11 w-full rounded-md border border-border-strong bg-surface-sunken px-3 font-mono text-sm"
        />
      </label>
      <button type="button" className={SECONDARY} onClick={() => void copy()}>
        {t("copy")}
      </button>
    </div>
  );
}

function Revoke({ busy, disabled, onRevoke }: { busy: boolean; disabled: boolean; onRevoke: () => void }) {
  const t = useTranslations("pack.ack");
  const [confirm, setConfirm] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) keep.current?.focus();
  }, [confirm]);
  if (!confirm) {
    return (
      <button
        ref={opener}
        type="button"
        disabled={disabled}
        className={`${SECONDARY} self-start text-danger`}
        onClick={() => {
          setConfirm(true);
        }}
      >
        {t("revoke")}
      </button>
    );
  }
  const cancel = () => {
    setConfirm(false);
    window.setTimeout(() => opener.current?.focus(), 0);
  };
  return (
    <div
      className="flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") cancel();
      }}
    >
      <p>{t("revokeConfirm")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || disabled}
          aria-busy={busy || undefined}
          onClick={onRevoke}
          // busy: full-strength fill + spinner like the public form's "Confirming…" (BL-01 6569408949
          // item 9, sweep M5); the faded fill stays for "disabled" (offline)
          className={`inline-flex min-h-11 items-center gap-2 rounded-md bg-danger px-4 font-semibold text-on-danger ${busy ? "cursor-wait" : "disabled:opacity-60"}`}
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" size={16} className="animate-spin motion-reduce:animate-none" />
          ) : null}
          {busy ? t("revoking") : t("revokeYes")}
        </button>
        <button ref={keep} type="button" className={SECONDARY} onClick={cancel}>
          {t("keep")}
        </button>
      </div>
    </div>
  );
}

function LinkBody(props: {
  link: Link;
  url: string | null;
  timeZone: string;
  busy: boolean;
  online: boolean;
  onCopied: (ok: boolean) => void;
  onRevoke: () => void;
  onCreate: () => void;
}) {
  const t = useTranslations("pack.ack");
  const d = useDates(props.timeZone);
  const { link } = props;
  const expires = t(link.expiryCapped ? "expiresWorkspace" : "expires", { date: d.day(link.expiresAt) });
  const createNew = (
    <button
      type="button"
      disabled={props.busy || !props.online}
      onClick={props.onCreate}
      className={`${SECONDARY} self-start`}
    >
      {props.busy ? t("creating") : t("createNew")}
    </button>
  );
  switch (link.status) {
    case "pending":
      return (
        <>
          {props.url !== null ? (
            <CopyBox url={props.url} onCopied={props.onCopied} />
          ) : (
            <p>{t("shownOnce", { time: d.time(link.createdAt) })}</p>
          )}
          <p className="text-sm text-text-muted">{expires}</p>
          {props.url !== null ? <p className="text-sm text-text-muted">{t("shareYourself")}</p> : null}
          <Revoke busy={props.busy} disabled={!props.online} onRevoke={props.onRevoke} />
        </>
      );
    case "accepted":
      return (
        <>
          {/* The current scope is not signed off: say so first, the earlier acceptance below. */}
          {link.earlierScope ? (
            <>
              <p>{t("scopeChanged")}</p>
              {createNew}
            </>
          ) : null}
          <p>
            {t("acceptedAt", { time: d.time(link.acceptedAt ?? link.createdAt) })}
            {link.earlierScope ? ` (${t("earlierScope")})` : ""}
          </p>
          <p className="text-sm text-text-muted">{t("inEvidence")}</p>
          {link.evidenceItemId !== null ? (
            <a
              href={`#evidence-${link.evidenceItemId}`}
              className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
              onClick={(e) => {
                e.preventDefault();
                openEvidence(link.evidenceItemId ?? "");
              }}
            >
              {t("viewEvidence")}
            </a>
          ) : null}
        </>
      );
    case "expired":
      return (
        <>
          <p>{t("expiredBody", { date: d.day(link.expiresAt) })}</p>
          {createNew}
        </>
      );
    case "revoked":
      return (
        <>
          <p>{t("revokedBody", { date: d.day(link.revokedAt ?? link.createdAt) })}</p>
          {createNew}
        </>
      );
    case "scope_changed":
      return (
        <>
          <p>{t("scopeChanged")}</p>
          {createNew}
        </>
      );
  }
}

async function fetchView(path: string): Promise<AckLinkView> {
  return getParsed(path, (s) => s.AckLinkViewSchema);
}

/** Pending → accepted is announced once, and the pack reloads to show the new evidence item. */
function useAcceptedAnnouncement(view: AckLinkView | undefined, onAccepted: () => void): string {
  const t = useTranslations("pack.ack");
  const last = useRef<AckLinkStatus | null>(null);
  const [text, setText] = useState("");
  const status = view?.link?.status ?? null;
  useEffect(() => {
    if (last.current === "pending" && status === "accepted") {
      setText(t("announceAccepted"));
      onAccepted();
    }
    last.current = status;
  }, [status, t, onAccepted]);
  return text;
}

export function AckLinkPanel({
  packId,
  timeZone,
  onAccepted,
}: {
  packId: string;
  timeZone: string;
  onAccepted: () => void;
}) {
  const t = useTranslations("pack.ack");
  const online = useOnline();
  const path = `/api/packs/${packId}/ack-links`;
  const { data, mutate } = useSWR<AckLinkView, unknown>(path, fetchView, {
    refreshInterval: (d) => (d?.link?.status === "pending" ? POLL_MS : 0),
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    keepPreviousData: true,
  });
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [live, setLive] = useState("");
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const announced = useAcceptedAnnouncement(data, onAccepted);

  const run = async (
    what: Failure["what"],
    call: () => Promise<ApiResult>,
    apply: (r: ApiResult) => void,
  ) => {
    setBusy(true);
    setFailure(null);
    const r = await call();
    setBusy(false);
    if (r.status >= 200 && r.status < 300) {
      apply(r);
      return;
    }
    setFailure({ what, reference: r.correlationId });
    void mutate();
  };
  const create = () =>
    void run(
      "create",
      () => postJson(path, {}, crypto.randomUUID()),
      (r) =>
        void loadSchemas().then((schemas) => {
          const body = schemas.AckLinkCreatedSchema.parse(r.body);
          setUrl(body.url);
          setLive(t("created"));
          void mutate(body.view, { revalidate: false });
        }),
    );
  const revoke = () => {
    const id = data?.link?.id;
    if (id === undefined) return;
    void run(
      "revoke",
      () => postJson(`${path}/${id}/revoke`, {}, crypto.randomUUID()),
      (r) => {
        setUrl(null);
        void loadSchemas().then((schemas) =>
          mutate(schemas.AckLinkViewSchema.parse(r.body), { revalidate: false }),
        );
      },
    );
  };

  return (
    <section aria-labelledby="ack-heading" className="flex flex-col gap-3" data-testid="ack-panel">
      <h2 id="ack-heading" className="text-xl font-semibold">
        {t("title")}
      </h2>
      <AckPanelBody
        view={data}
        url={url}
        timeZone={timeZone}
        busy={busy}
        online={online}
        onCreate={create}
        onRevoke={revoke}
        onCopied={(ok) => {
          const note = ok ? t("copied") : t("copyFailed");
          setLive(note);
          setCopyNote(note);
          window.setTimeout(() => {
            setCopyNote(null);
          }, 4000);
        }}
      />
      {copyNote !== null && url !== null ? (
        <p
          className="self-start rounded-md bg-text px-3 py-2 text-sm text-surface"
          data-testid="ack-copy-note"
        >
          {copyNote}
        </p>
      ) : null}
      {failure !== null ? (
        <ErrorPanel
          title={t(failure.what === "create" ? "createError" : "revokeError")}
          reference={failure.reference}
          onRetry={failure.what === "create" ? create : revoke}
        />
      ) : null}
      {!online ? <p className="text-sm text-text-muted">{t("offline")}</p> : null}
      <p role="status" aria-live="polite" className="sr-only" data-testid="ack-live">
        {announced || live}
      </p>
    </section>
  );
}

function AckPanelBody(props: {
  view: AckLinkView | undefined;
  url: string | null;
  timeZone: string;
  busy: boolean;
  online: boolean;
  onCreate: () => void;
  onRevoke: () => void;
  onCopied: (ok: boolean) => void;
}) {
  const t = useTranslations("pack.ack");
  const { view } = props;
  if (view === undefined)
    return <div className="h-12 animate-pulse rounded-md bg-skeleton" aria-hidden="true" />;
  // Evidence is immutable, so once a pack has a scope item it always has one: a link implies a scope.
  if (view.link === null) {
    if (view.scopeItemId === null) {
      return (
        <p>
          {t("noScope")}{" "}
          <a
            href="#intake"
            className="text-accent underline underline-offset-2"
            onClick={() => document.getElementById("intake-open")?.click()}
          >
            {t("addScope")}
          </a>
        </p>
      );
    }
    return (
      <>
        <p>{t("intro")}</p>
        <button
          type="button"
          disabled={props.busy || !props.online}
          onClick={props.onCreate}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-md border border-border-strong bg-surface px-4 font-medium disabled:opacity-60"
        >
          {props.busy ? t("creating") : t("create")}
        </button>
      </>
    );
  }
  return (
    <>
      <Badge status={view.link.earlierScope ? "scope_changed" : view.link.status} />
      <LinkBody link={view.link} {...props} />
    </>
  );
}
