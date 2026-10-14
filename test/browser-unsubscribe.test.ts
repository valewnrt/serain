import { describe, expect, it } from "vitest";
import type { BrowserSession, PageElement, PageSnapshot, PilotAction } from "../src/browser/pilot.js";
import type { SystemOne } from "../src/browser/typesafe.js";

const { pageUnsubscriber, confirmsUnsubscribe, unsubscribeButton } = await import("../src/browser/unsubscribe.js");

const URL_WITH_TOKEN = "https://u1.ct.sendgrid.net/asm/unsubscribe/?user_id=1&data=geheim-token";

const page = (text: string, elements: PageElement[] = [], extra: Partial<PageSnapshot> = {}): PageSnapshot => ({
  url: URL_WITH_TOKEN,
  title: "Kelvo",
  text,
  view: text,
  elements,
  scroll: { up: false, down: false },
  status: 200,
  ...extra,
});
const button = (id: number, label: string): PageElement => ({ id, kind: "button", label });

/** A session that shows the next page after every click. */
function fakeSession(pages: PageSnapshot[]) {
  let index = 0;
  const actions: PilotAction[] = [];
  let closed = false;
  const session: BrowserSession = {
    snapshot: async () => pages[Math.min(index, pages.length - 1)] as PageSnapshot,
    act: async (action) => {
      actions.push(action);
      if (action.op === "click") index += 1;
    },
    close: async () => void (closed = true),
  };
  return { session, actions, closed: () => closed };
}

const noJev: SystemOne = {
  ask: async () => {
    throw new Error("Jev must not be asked here");
  },
};

describe("unsubscribe page: what counts as confirmed (addendum D37)", () => {
  it("recognises the confirmation, but not the announcement next to the button", () => {
    expect(confirmsUnsubscribe(page("You have been unsubscribed from Kelvo emails."))).toBe(true);
    expect(confirmsUnsubscribe(page("Du wurdest erfolgreich abgemeldet."))).toBe(true);
    expect(confirmsUnsubscribe(page("Fertig.", [button(1, "Resubscribe")]))).toBe(true);
    expect(confirmsUnsubscribe(page("Click below and you will no longer receive our emails.", [button(1, "Unsubscribe")]))).toBe(false);
    expect(confirmsUnsubscribe(page("Want to unsubscribe? Click here."))).toBe(false);
  });

  it("only clicks a button that says exactly unsubscribe, and prefers \"from all\"", () => {
    expect(unsubscribeButton(page("", [button(1, "Subscribe"), button(2, "Unsubscribe"), button(3, "Unsubscribe from all")]))?.id).toBe(3);
    expect(unsubscribeButton(page("", [button(1, "Newsletter abbestellen")]))?.id).toBe(1);
    expect(unsubscribeButton(page("", [button(1, "Manage preferences"), button(2, "Subscribe to our newsletter")]))).toBeNull();
  });

  it("knows confirmations and buttons in the languages senders write in", () => {
    const confirmed = [
      "Vous avez bien été désinscrit de notre newsletter.",
      "Te has dado de baja correctamente.",
      "Sei stato disiscritto dalla nostra newsletter.",
      "Je bent succesvol afgemeld.",
      "Abonelikten başarıyla çıkarıldınız.",
      "Você foi descadastrado da nossa lista.",
      "Zostałeś pomyślnie wypisany z newslettera.",
    ];
    for (const text of confirmed) expect(confirmsUnsubscribe(page(text)), text).toBe(true);
    for (const label of ["Se désabonner", "Darme de baja", "Annulla iscrizione", "Afmelden", "Abonelikten çık", "Cancelar inscrição", "Wypisz mnie"]) {
      expect(unsubscribeButton(page("", [button(1, "Manage preferences"), button(2, label)]))?.id, label).toBe(2);
    }
    expect(confirmsUnsubscribe(page("C'est fait.", [button(1, "Se réabonner")]))).toBe(true);
    // Subscribing or managing is never the unsubscribe button, in any of these languages.
    for (const label of ["S'abonner", "Suscribirse", "Iscriviti", "Aanmelden", "Abone ol", "Inscrever-se", "Zapisz się", "Gérer mes préférences"]) {
      expect(unsubscribeButton(page("", [button(1, label)])), label).toBeNull();
    }
  });

  it("is fail closed on a page in a language it does not know: nothing counts as confirmed, no button is clicked", () => {
    // Finnish and Japanese: the page may well say "unsubscribed", the code cannot read it and leaves the mails.
    expect(confirmsUnsubscribe(page("Tilauksesi on peruttu onnistuneesti."))).toBe(false);
    expect(confirmsUnsubscribe(page("配信停止が完了しました。"))).toBe(false);
    expect(unsubscribeButton(page("", [button(1, "Peruuta tilaus"), button(2, "配信停止")]))).toBeNull();
  });

  it("does not take an announcement in another language for a confirmation while the button is still there", () => {
    expect(confirmsUnsubscribe(page("Cliquez ci-dessous et vous ne recevrez plus nos e-mails.", [button(1, "Se désabonner")]))).toBe(false);
    expect(confirmsUnsubscribe(page("Haz clic y ya no recibirás correos.", [button(1, "Darme de baja")]))).toBe(false);
  });
});

describe("unsubscribe page in the browser (addendum D37)", () => {
  it("unsubscribes without a model when the page confirms it on opening", async () => {
    const fake = fakeSession([page("You have been unsubscribed.")]);
    const run = pageUnsubscriber({ chromePath: "/chrome", jev: noJev, open: async () => fake.session });
    expect(await run(URL_WITH_TOKEN)).toEqual({ ok: true, reason: "confirmed by the page" });
    expect(fake.actions).toEqual([]);
    expect(fake.closed()).toBe(true);
  });

  it("clicks the unsubscribe button itself and checks the page afterwards", async () => {
    const fake = fakeSession([page("Unsubscribe alex@example.org from Kelvo?", [button(4, "Unsubscribe")]), page("You have been unsubscribed.")]);
    const run = pageUnsubscriber({ chromePath: "/chrome", jev: noJev, open: async () => fake.session });
    expect((await run(URL_WITH_TOKEN)).ok).toBe(true);
    expect(fake.actions).toEqual([{ op: "click", id: 4 }]);
  });

  it("asks Jev only after that, and Jev sees neither a mail address nor the token", async () => {
    const fake = fakeSession([
      page("Manage email for alex@example.org and news_at_kelvo@privaterelay.appleid.com, also alex%40example.org", [
        { id: 1, kind: "input", role: "checkbox", label: "Product updates", state: "checked" },
        button(2, "Save"),
      ]),
    ]);
    const seen: string[] = [];
    const jev: SystemOne = {
      ask: async (state) => {
        seen.push(JSON.stringify(state));
        return { goal_met: { type: "noul", noul: 0.95 }, stuck: { type: "noul", noul: 0 } };
      },
    };
    const run = pageUnsubscriber({ chromePath: "/chrome", jev, open: async () => fake.session });
    // Jev thinks the goal is met, the page does not say so: that does not count.
    expect(await run(URL_WITH_TOKEN)).toEqual({ ok: false, reason: "not confirmed on the page" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/@|%40/);
    expect(seen[0]).not.toContain("geheim-token");
    expect(seen[0]).toContain("[address]");
  });

  it("says honestly when the page does not open, refuses, or confirms nothing without Jev", async () => {
    const failing = pageUnsubscriber({ chromePath: "/chrome", jev: null, open: async () => Promise.reject(new Error("net::ERR")) });
    expect(await failing(URL_WITH_TOKEN)).toEqual({ ok: false, reason: "the page could not be opened" });
    const checking = pageUnsubscriber({ chromePath: "/chrome", jev: null, open: async () => fakeSession([page("Checking your browser", [])]).session });
    expect(await checking(URL_WITH_TOKEN)).toEqual({ ok: false, reason: "not confirmed on the page" });
    const gone = pageUnsubscriber({ chromePath: "/chrome", jev: null, open: async () => fakeSession([page("Not found", [], { status: 404 })]).session });
    expect(await gone(URL_WITH_TOKEN)).toEqual({ ok: false, reason: "page answered with HTTP 404" });
    const noModel = pageUnsubscriber({ chromePath: "/chrome", jev: null, open: async () => fakeSession([page("Choose your lists", [button(1, "Save")])]).session });
    expect(await noModel(URL_WITH_TOKEN)).toEqual({ ok: false, reason: "not confirmed on the page" });
  });
});
