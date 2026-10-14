import { BROWSE_HARD_MARGIN_MS, BROWSE_TIMEOUT_MS } from "../config/limits.js";
import { runPilot, type BrowserSession, type PageElement, type PageSnapshot } from "./pilot.js";
import { openBrowserSession } from "./session.js";
import type { SystemOne } from "./typesafe.js";

/**
 * Unsubscribing via the unsubscribe page (addendum D37 of 2026-10-03). The link
 * comes from the code (`unsubscribeLink`, `List-Unsubscribe` without one-click),
 * the owner confirmed it with its host in the preview; here it is only carried out.
 *
 * **The browser is the one from D35:** throwaway profile without logins and
 * cookies, filter proxy in front of the internal network, no downloads, no
 * password fields. A crafted unsubscribe page thus achieves nothing but a request
 * from the server to a public host, and that only confirms what the sender
 * already knows: that it writes to this address. Hence never for spam (D37).
 *
 * **First without a model, then Jev.** Many pages unsubscribe on opening or have
 * exactly one "unsubscribe" button; the code recognises that. Only when that is
 * not enough does Jev click, with a fixed goal and without typing anything. Jev
 * sees neither a mail address (all masked, Apple's relay addresses too) nor the
 * query of the address with the unsubscribe token: Typesafe has no ZDR (D35).
 *
 * **It is done only when the page says so.** A `done` from Jev does not count;
 * the code reads the last page. If there is no confirmation, the result is "not
 * confirmed" and the mails stay, so the next attempt still finds the link.
 *
 * **Languages.** The page speaks the sender's language, not the owner's. The code
 * knows confirmations and buttons in English, German, French, Spanish, Italian,
 * Dutch, Turkish, Portuguese and Polish. On a page in any other language it
 * recognises nothing, and that is the safe side: then Jev clicks, and without a
 * confirmation the code can read, the result stays "not confirmed".
 */

export interface PageUnsubscribeResult {
  ok: boolean;
  /** Why not, in fixed words: third-party page content never goes back to the model. */
  reason: string;
}

export type PageUnsubscribe = (url: string) => Promise<PageUnsubscribeResult>;

const GOAL =
  "Unsubscribe this email address from all emails of this sender. Only unsubscribe or confirm the unsubscription: " +
  "never subscribe, sign in, buy, or share anything. If the page insists on a reason, pick the most neutral option.";

/**
 * What a page says once the unsubscription has gone through. Deliberately narrow: "click here to unsubscribe" does
 * not match, and an announcement next to a remaining button does not count (`confirmsUnsubscribe`).
 */
const CONFIRMED = new RegExp(
  [
    // English
    "(you|you've|you have|you are|you were|you're|this (email|address) has been)( now)?( been)?( successfully)? (unsubscribed|removed|opted out)",
    "successfully unsubscribed|unsubscribed successfully|unsubscribe (was )?successful",
    "you (will|won't|will not) (no longer|not) receive",
    "no longer receive (any )?(e-?mails|emails|newsletters|messages)",
    // German
    "erfolgreich (abgemeldet|ausgetragen)",
    "(sie|du) (sind|bist|wurden?|wurdest) (nun |jetzt )?(erfolgreich )?(abgemeldet|ausgetragen)",
    "abmeldung (war |ist )?(erfolgreich|bestätigt|abgeschlossen)",
    "(e-?mail-?adresse|adresse) wurde (erfolgreich )?(abgemeldet|ausgetragen|entfernt)",
    "(erhältst|erhalten) (du|sie) (ab sofort |künftig )?keine",
    // French
    "(vous|tu) (avez|as|êtes|es) (bien |été |bien été )*(désinscrite?s?|désabonnée?s?)",
    "(désinscription|désabonnement) (réussie?|confirmée?|effectuée?|prise? en compte|enregistrée?)",
    "(vous ne recevrez|tu ne recevras) plus",
    // Spanish
    "(te has|se ha|has|ha) (sido )?(dado|dada) de baja",
    "(baja|cancelación de (la |tu |su )?suscripción) (realizada|confirmada|completada|procesada)",
    "ya no (recibirás|recibirá)",
    // Italian
    "(sei|è|sono) (stat[oaie] )?(ora )?disiscritt[oaie]",
    "(sei|è|sono) stat[oaie] (rimoss[oaie]|cancellat[oaie]) dalla (lista|newsletter|mailing list)",
    "disiscrizione (avvenuta|completata|confermata|riuscita|effettuata)",
    "non riceverai più",
    // Dutch
    "(je|u|jij) bent (nu |succesvol |met succes )*(afgemeld|uitgeschreven)",
    "(succesvol|met succes) (afgemeld|uitgeschreven)",
    "afmelding (is )?(gelukt|bevestigd|voltooid|geslaagd)",
    // Turkish
    "abonelikten (başarıyla )?(çıkarıldınız|çıktınız|çıkıldı|çıkışınız (yapıldı|tamamlandı))",
    "aboneliğiniz (başarıyla )?(iptal edildi|sonlandırıldı)",
    // Portuguese
    "(você|voce) (foi|está) (descadastrad[oa]|removid[oa])",
    "(inscrição|subscrição|assinatura) cancelada",
    "(descadastro|cancelamento da (inscrição|subscrição|assinatura)) (realizado|confirmado|efetuado|concluído)",
    "(não|nao) (receberá|receberás|vai receber) mais",
    // Polish
    "(zostałeś|zostałaś|został|została|zostało) (pomyślnie )?(wypisan[yaoe]|usunięt[yaoe])",
    "pomyślnie (wypisano|wypisałeś|wypisałaś)",
    "rezygnacja (z subskrypcji |z newslettera )?(została )?(potwierdzona|przyjęta|zakończona)",
    "nie będziesz (już )?otrzymywać",
  ].join("|"),
  "iu",
);
/** A button that subscribes again: on a confirmation page it means the unsubscription went through. */
const RESUBSCRIBE = new RegExp(
  "(?<!\\p{L})(" +
    [
      "re-?subscribe",
      "erneut (anmelden|abonnieren)|wieder (anmelden|abonnieren)",
      "(se |me )?réabonner|(se |me )?réinscrire",
      "volver a suscribir(me|se)?|suscribirme de nuevo|resuscribir(me|se)?",
      "iscriviti di nuovo|reiscriviti|riattiva (l'|l’)?iscrizione",
      "opnieuw (aanmelden|inschrijven|abonneren)",
      "(yeniden|tekrar) abone ol",
      "inscrever(-se|-me)? novamente|voltar a (se |me )?inscrever|assinar novamente",
      "zapisz się ponownie|ponownie (zapisz się|subskrybuj)",
    ].join("|") +
    ")(?!\\p{L})",
  "iu",
);
/** A button that does exactly that: short, never "subscribe" alone, no preferences. Anchored to the whole label. */
const UNSUBSCRIBE_BUTTON = new RegExp(
  "^\\s*((yes|ja|oui|sí|sì|si|evet|sim|tak),?\\s*)?(" +
    [
      // English
      "unsubscribe( me)?( from (all|everything)( emails| lists)?)?|confirm( unsubscribe)?|opt[\\s-]?out",
      // German
      "abmelden|jetzt abmelden|abbestellen|newsletter abbestellen|austragen|bestätigen|abmeldung bestätigen",
      // French
      "(se |me )?désabonner|(se |me )?désinscrire|désinscription|désabonnement|confirmer( la désinscription| le désabonnement)?",
      // Spanish
      "darme de baja|darse de baja|dar de baja|cancelar (la |mi )?suscripción|anular (la |mi )?suscripción|confirmar( (la )?baja)?",
      // Italian
      "annulla (l'|l’)?iscrizione|disiscriviti|cancellami|conferma( (la )?disiscrizione)?",
      // Dutch
      "afmelden|nu afmelden|uitschrijven|bevestigen|afmelding bevestigen",
      // Turkish
      "abonelikten çık|aboneliği iptal et|onayla",
      // Portuguese
      "cancelar (a |minha )?(inscrição|subscrição|assinatura)|descadastrar(-me)?|confirmar( (o )?descadastro)?",
      // Polish
      "wypisz( mnie)?( się)?|zrezygnuj z subskrypcji|anuluj subskrypcję|potwierdź( rezygnację)?",
    ].join("|") +
    ")\\s*[.!]?\\s*$",
  "iu",
);

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const hideAddresses = (text: string) => text.replace(EMAIL, "[address]").replace(/[^\s@<>()"',;:]+%40[^\s@<>()"',;:]+\.[a-z]{2,}/gi, "[address]");

/** Without query and fragment: that is where the unsubscribe token sits, and sometimes the address. */
function bareUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return hideAddresses(`${url.origin}${url.pathname}`);
  } catch {
    return "";
  }
}

/** What the pilot, and with it Jev, sees: the same page, without mail addresses and without token. */
export function masked(session: BrowserSession): BrowserSession {
  const element = (entry: PageElement): PageElement => ({
    ...entry,
    label: hideAddresses(entry.label),
    ...(entry.value !== undefined ? { value: hideAddresses(entry.value) } : {}),
    ...(entry.options ? { options: entry.options.map(hideAddresses) } : {}),
  });
  return {
    async snapshot() {
      const page = await session.snapshot();
      return {
        ...page,
        url: bareUrl(page.url),
        title: hideAddresses(page.title),
        text: hideAddresses(page.text),
        view: hideAddresses(page.view),
        elements: page.elements.map(element),
      };
    },
    act: (action, text) => session.act(action, text),
    close: () => session.close(),
  };
}

const actionable = (entry: PageElement) => entry.kind === "button" || entry.kind === "link";

export function confirmsUnsubscribe(page: PageSnapshot): boolean {
  // If the unsubscribe button is still there, "you will no longer receive mails" is an announcement, not a confirmation.
  if (unsubscribeButton(page)) return false;
  return CONFIRMED.test(page.text) || page.elements.some((entry) => actionable(entry) && RESUBSCRIBE.test(entry.label));
}

export function unsubscribeButton(page: PageSnapshot): PageElement | null {
  const matches = page.elements.filter((entry) => actionable(entry) && UNSUBSCRIBE_BUTTON.test(entry.label));
  // "from all" before the single list: the owner wants nothing at all from this sender anymore.
  return matches.find((entry) => /\b(all|everything)\b/i.test(entry.label)) ?? matches[0] ?? null;
}

export function pageUnsubscriber(options: {
  chromePath: string;
  /** Without Jev it stays with the part without a model. */
  jev: SystemOne | null;
  open?: (url: string, chromePath: string) => Promise<BrowserSession>;
}): PageUnsubscribe {
  const open = options.open ?? openBrowserSession;

  async function run(session: BrowserSession): Promise<PageUnsubscribeResult> {
    let page = await session.snapshot();
    // Let it build first: unsubscribe pages are often an empty shell that loads by script.
    for (let waits = 0; waits < 2 && !page.view && page.elements.length === 0; waits += 1) {
      await session.act({ op: "wait" });
      page = await session.snapshot();
    }
    if ((page.status ?? 200) >= 400) return { ok: false, reason: `page answered with HTTP ${page.status}` };
    if (confirmsUnsubscribe(page)) return { ok: true, reason: "confirmed by the page" };
    for (let clicks = 0; clicks < 2; clicks += 1) {
      const button = unsubscribeButton(page);
      if (!button) break;
      try {
        await session.act({ op: "click", id: button.id });
      } catch {
        break;
      }
      page = await session.snapshot();
      if (confirmsUnsubscribe(page)) return { ok: true, reason: "confirmed by the page" };
    }
    if (!options.jev) return { ok: false, reason: "not confirmed on the page" };
    const piloted = await runPilot(session, GOAL, { jev: options.jev, inputs: [] });
    const last = await session.snapshot().catch(() => piloted.page);
    if (confirmsUnsubscribe(last)) return { ok: true, reason: "confirmed by the page" };
    return { ok: false, reason: "not confirmed on the page" };
  }

  return async (url) => {
    let session: BrowserSession;
    try {
      session = masked(await open(url, options.chromePath));
    } catch {
      return { ok: false, reason: "the page could not be opened" };
    }
    // The pilot checks its time between steps; this limit also holds when a step hangs.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<PageUnsubscribeResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: "the page did not react in time" }), BROWSE_TIMEOUT_MS + BROWSE_HARD_MARGIN_MS);
    });
    try {
      return await Promise.race([run(session).catch(() => ({ ok: false, reason: "the browser failed on the page" })), deadline]);
    } finally {
      clearTimeout(timer);
      await session.close().catch(() => undefined);
    }
  };
}
