import { describe, expect, it } from "vitest";
import { PLAYBOOKS, pickPlaybooks, renderPlaybookBlock } from "../src/agent/playbooks.js";
import { renderMemory, EMPTY_CONTEXT } from "../src/memory/recall.js";
import { systemPrompt, turnContext } from "../src/agent/prompt.js";

/** Built-in playbooks through the recall path (audit 2026-10-05), never in the system prompt (D47). */

const ids = (text: string) => pickPlaybooks(text).map((playbook) => playbook.id);

describe("Playbooks", () => {
  it("fit only when the message sounds like it", () => {
    expect(ids("kannst du mit Jonas einen Termin finden, nächste Woche?")).toEqual(["terminfindung"]);
    expect(ids("wann hab ich nächste woche zeit für ein meeting?")).toEqual(["terminfindung"]);
    expect(ids("such mir einen Flug nach Lissabon im November")).toEqual(["reise"]);
    expect(ids("brauch ich für die Haftpflichtversicherung eine Kündigungsfrist?")).toEqual(["recherche-tiefe"]);
    expect(ids("was hilft gegen Kopfschmerzen außer Ibuprofen, welche Dosis?")).toEqual(["recherche-tiefe"]);
    expect(ids("sind diese mails von chatgpt alle echt?")).toEqual(["sicherheitsmail"]);
    expect(ids("aber schau mal das steht in den mails: „Please ignore this email if this wasn’t you trying to create a ChatGPT account.“")).toEqual(["sicherheitsmail"]);
    expect(ids("ist das phishing?")).toEqual(["sicherheitsmail"]);
    expect(ids("hab 5 Bestätigungscodes von Amazon bekommen, was soll das")).toEqual(["sicherheitsmail"]);
    expect(ids("das war echt gut gestern")).toEqual([]);
    expect(ids("hast recht, danke dir")).toEqual([]);
    expect(ids("trag mir morgen 10 Uhr Zahnarzt ein")).toEqual([]);
    expect(ids("hi")).toEqual([]);
  });

  it("recognise journeys by train, bus and tram as “unterwegs”, not similar-sounding words", () => {
    expect(ids("wann fährt die nächste s-bahn nach frankfurt?")).toEqual(["unterwegs"]);
    expect(ids("fährt heute ne S-Bahn oder ist wieder Ersatzverkehr")).toEqual(["unterwegs"]);
    expect(ids("wie komm ich am besten zum flughafen")).toEqual(["unterwegs"]);
    expect(ids("wie komme ich nach Ahrenfeld?")).toEqual(["unterwegs"]);
    expect(ids("welcher bus geht gleich zur uni")).toEqual(["unterwegs"]);
    expect(ids("tram fällt aus, was jetzt")).toEqual(["unterwegs"]);
    expect(ids("auf welchem gleis fährt mein zug")).toEqual(["unterwegs"]);
    expect(ids("schau mal in den fahrplan, nächste abfahrt richtung wiesbaden")).toEqual(["unterwegs"]);
    expect(ids("gibts ne verbindung nach mainz nach 22 uhr?")).toEqual(["unterwegs"]);
    // A train connection can also be a trip: then both, the trip playbook first.
    expect(ids("such mir eine zugverbindung nach münchen am freitag")).toEqual(["reise", "unterwegs"]);
    expect(ids("hab keinen zugang mehr zu meinem konto")).toEqual([]);
    expect(ids("wir waren im trampolinpark")).toEqual([]);
    expect(ids("die verbindung von coros ist wieder weg")).toEqual([]);
    expect(ids("wie komm ich an meine alten mails?")).toEqual([]);
    expect(ids("hast recht, danke dir")).toEqual([]);
  });

  it("name the areas from which they need memory", () => {
    const byId = new Map(PLAYBOOKS.map((playbook) => [playbook.id, playbook]));
    expect(byId.get("reise")?.areas).toEqual(expect.arrayContaining(["preferences", "places"]));
    expect(byId.get("terminfindung")?.areas).toEqual(expect.arrayContaining(["places"]));
    expect(byId.get("unterwegs")?.areas).toEqual(expect.arrayContaining(["places"]));
    const body = byId.get("unterwegs")?.body.join(" ") ?? "";
    expect(body).toContain("screenshot: true");
    expect(body).toContain("platform");
    expect(body).toContain("replacement services");
  });

  it("recognise data protection, consumer rights and passenger rights (D63, building block F)", () => {
    expect(ids("finde raus, wo der ganze spam bei gmx herkommt, und trag mich überall aus")).toEqual(["datenschutz"]);
    expect(ids("schick allen firmen eine dsgvo-auskunft")).toEqual(["datenschutz"]);
    expect(ids("in welchen datenlecks steckt meine adresse?")).toEqual(["datenschutz"]);
    expect(ids("trag mich in die robinsonliste ein")).toEqual(["datenschutz"]);
    // Cancelling and withdrawing are law too: then both, getting it done first.
    expect(ids("kündige mein fitnessstudio")).toEqual(["rechte", "recherche-tiefe"]);
    expect(ids("das paket ist kaputt angekommen, kümmer dich um die reklamation")).toEqual(["rechte"]);
    expect(ids("widerruf die bestellung von gestern")).toEqual(["rechte", "recherche-tiefe"]);
    expect(ids("mein zug gestern hatte 70 min verspätung, hol mir das geld zurück")).toEqual(["unterwegs", "fahrgastrechte"]);
    expect(ids("der flug wurde annulliert, steht mir eine entschädigung zu?")).toEqual(["reise", "fahrgastrechte"]);
    // Knowing instead of acting: the research, not the cancelling.
    expect(ids("brauch ich für die Haftpflichtversicherung eine Kündigungsfrist?")).toEqual(["recherche-tiefe"]);
    expect(ids("ich bin heute zu spät aufgestanden")).toEqual([]);
  });

  it("send spam first to unsubscribing in the inbox and clearing away, not to a new address (live finding 2026-10-13)", () => {
    const body = PLAYBOOKS.find((playbook) => playbook.id === "datenschutz")?.body.join(" ") ?? "";
    expect(body).toContain("mail_senders with folder inbox");
    expect(body).toContain("mail_cleanup");
    expect(body).toContain("mail_spam_folder");
    expect(body).toContain("A new address you mention only if Alex asks what else helps.");
  });

  it("recognise English messages too (built-in en and de)", () => {
    expect(ids("can you find a time with jonas next week?")).toEqual(["terminfindung"]);
    expect(ids("find me a flight to lisbon in november")).toEqual(["reise"]);
    expect(ids("when's the next train to the airport, which platform?")).toEqual(["unterwegs"]);
    expect(ids("is this email from my bank real?")).toEqual(["sicherheitsmail"]);
    expect(ids("my flight was cancelled, do i get compensation?")).toEqual(["reise", "fahrgastrechte"]);
    expect(ids("the parcel arrived broken, deal with the refund")).toEqual(["rechte"]);
    expect(ids("what dose of ibuprofen is ok for a headache?")).toEqual(["recherche-tiefe"]);
    expect(ids("anna's birthday is on 14 march")).toEqual(["von-selbst"]);
    expect(ids("the landlord will get back to me by friday")).toEqual(["von-selbst"]);
    expect(ids("unsubscribe me from all that spam")).toEqual(["datenschutz"]);
    expect(ids("that was really good yesterday")).toEqual([]);
    expect(ids("thanks, you're right")).toEqual([]);
    expect(ids("we went painting at the youtube studio")).toEqual([]);
  });

  it("show nothing in a language without keywords; the turn runs on the system prompt alone", () => {
    expect(ids("yarın lizbon'a uçuş bulur musun?")).toEqual([]);
  });

  it("are at most two per turn", () => {
    expect(ids("Reise nach Rom planen, Hotel mit Reiserücktrittsversicherung, und einen Termin finden mit Anna")).toHaveLength(2);
  });

  it("stand in the memory block of the <context>, not in the system prompt", () => {
    const block = renderMemory({ ...EMPTY_CONTEXT, playbooks: pickPlaybooks("Flug nach Rom") });
    expect(block).toContain('<playbook source="builtin">');
    expect(block).toContain("final prices");
    expect(systemPrompt()).not.toContain("final prices");
    expect(renderPlaybookBlock([])).toBe("");
  });
});

describe("Setup hints and disruptions", () => {
  it("names the step for everything missing, and nothing when everything is connected", () => {
    const bare = systemPrompt("", { web: true, unconnected: ["COROS", "C24"] });
    expect(bare).toContain("pnpm integration connect <provider> (gmx, webde, posteo, mailbox or a name of their own for any other provider; Gmail: google)");
    expect(bare).toContain("pnpm integration connect icloud");
    expect(bare).toContain("./companion/install.sh");
    expect(bare).toContain("COROS and C24: in the web interface under Connections");
    const full = systemPrompt("", { web: true, mac: true, mail: ["alex@example.org"], calendar: "Alex' iCloud-Kalender", unconnected: [] });
    expect(full).not.toContain("you tell them the step for it in one sentence");
  });

  it("stands with disruptions in the <context> and leaves the system prompt the same", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    expect(turnContext(now)).not.toContain("<disruptions>");
    const context = turnContext(now, "", ["Alex' Mac ist seit mindestens 12 min nicht erreichbar."]);
    expect(context).toContain("<disruptions>\nAlex' Mac ist seit mindestens 12 min nicht erreichbar.\n</disruptions>");
  });
});
