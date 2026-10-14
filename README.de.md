# Serain

**Ein persönlicher KI-Agent, dem du über iMessage schreibst.** Ein Besitzer, selbst gehostet, läuft rund um die Uhr auf deinem eigenen Server. Serain schreibt wie ein Freund, nicht wie ein Chatbot: kurz, natürlich, in deiner Sprache, ein Tapback statt einer Nachricht, wenn das reicht.

[serain.si](https://serain.si/de/) · [Connectors](https://serain.si/de/connectors/) · [English version: README.md](README.md)

> Serain ist ein privates Projekt, gebaut mit der Sorgfalt eines Produkts. Es ist kein gehosteter Dienst, hat keinen Mehrnutzer-Modus, und jedes Konto und jeden Schlüssel bringst du selbst mit. Lies [Rechtliches](#rechtliches) und [Kosten](#kosten), bevor du anfängst.

## Was Serain kann

Serain antwortet in der Sprache, in der du schreibst: Deutsch rein, Deutsch raus; Türkisch rein, Türkisch raus. `OWNER_LANGUAGE` (Vorgabe `en`) ist nur der Ausgangspunkt, bis Serain deine Nachrichten kennt. Feste Texte wie Vorschauen und Bestätigungsfragen sind auf Englisch und Deutsch eingebaut; für jede andere Sprache werden sie einmal übersetzt und zwischengespeichert. Was zählt, etwa Text und Empfänger einer Mail, steht immer wörtlich da. Bestätigt wird mit 👍, egal in welcher Sprache. Prüfungen, die deine Worte lesen (ein „ja“, das bestätigt, ein Absender, den du selbst genannt hast), kennen Englisch und Deutsch, dazu die übersetzten Wörter deiner aktuellen Sprache, wo das sicher ist; in jedem anderen Fall entscheidet sich Serain für eine Vorschau.

Highlights:

- **Postfach aufräumen mit Vorschau.** Serain findet Newsletter und Spam-Absender im ganzen Postfach, meldet über den Abmelde-Header ab (oder über den Abmelde-Link, den der Browser des Servers öffnet), verschiebt Mails in den Papierkorb oder den Spam-Ordner und zeigt dir vorher eine Vorschau für den ganzen Auftrag. Eine Behalten-Liste setzt der Code durch. Endgültig gelöscht wird nie.
- **Post, die sich selbst liest.** Liest jeden Ordner deiner IMAP-Postfächer und von Gmail, öffnet PDF-Anhänge in einer Sandbox, sagt dir Bescheid bei Antworten, auf die du wartest, und bei Fristen und Buchungen, die ihm auffallen, und schickt Mails in deinem Namen erst, nachdem du Empfänger und Text genau so bestätigt hast.
- **Kalender.** iCloud (CalDAV) oder Google Kalender: freie Zeiten, Termine anlegen, verschieben und löschen, Serien, pro Termin der passende Kalender.
- **Erinnerungen und Aufträge.** „Erinnere mich morgen um 8“, „schau jeden Morgen nach dem Zug“, Wächter, die sich melden, wenn sich etwas ändert.
- **Web-Recherche.** Suche, Seiten abrufen und ein echter Browser auf dem Server für Seiten, die einen brauchen, mit Link-Vorschauen der Quellen, die er wirklich geöffnet hat.
- **Videos.** Schaut YouTube und optional TikTok, Instagram und X mit Bild und Ton (optional, siehe [Rechtliches](#rechtliches)).
- **Gedächtnis.** Fakten mit Herkunft, ein kompaktes Bild von dir, das jede Nacht verdichtet wird, und Vorgehensweisen, die es lernt („mach das nächstes Mal so“). Alles davon kannst du ansehen und korrigieren.
- **Sprachnachrichten** in beide Richtungen: lokal in der Sandbox transkribiert (die gesprochene Sprache wird erkannt), beantwortet mit einer lokalen Stimme auf Deutsch, Englisch, Spanisch, Französisch, Italienisch, Niederländisch, Polnisch, Portugiesisch, Russisch oder Türkisch, sonst als Text.
- **Bestätigung für alles, was etwas bewirkt.** Siehe [Sicherheitsmodell](#sicherheitsmodell).

Optional dazu: ein Webinterface (Audit-Log, Gedächtnis, ein versiegelter Tresor für Zugänge und Dateien, Verbindungen), ein Mac-Companion für Apple-Kalender, Erinnerungen und Kontakte, eine COROS-Uhr und Lesezugriff auf dein eigenes Bankkonto.

## Architektur

Serain ist ein langlebiger Node.js-22-Prozess (TypeScript, strict) unter systemd auf einer kleinen Linux-VM. iMessage kommt über [Photon](https://photon.codes) per ausgehendem gRPC-Stream, deshalb öffnet der Server außer SSH keinen Port. Ein Chat-Modell (Claude über das Claude Agent SDK, mit vorgewärmten Prozessen für schnelle Antworten) spricht mit dir und hält deine persönlichen Daten; ein Executor-Modell recherchiert und browst im Web und sieht weder dein Postfach noch dein Gedächtnis. Code läuft in einer Docker-Sandbox ohne Netz. Der Zustand liegt in Supabase-Postgres: Gedächtnis mit pgvector, das Audit-Log (nur anhängen), Bestätigungen, Aufträge und versiegelte Zugänge. Das optionale Webinterface ist ein Cloudflare Worker hinter Cloudflare Access; der optionale Mac-Companion ist nur über einen SSH-Remote-Tunnel auf Loopback erreichbar. Details und die Gründe hinter jeder Entscheidung (die `D`-Nummern im Code): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sicherheitsmodell

Serain kann Mails senden und darf irgendwann Geld ausgeben. Sicherheit hat Vorrang, vor Stil und Autonomie.

- **Stufen.** Jedes Werkzeug hat eine Stufe: `read`, `write_reversible`, `irreversible` oder `money`. Die Registry weigert sich, ein Werkzeug der Stufe `irreversible` oder `money` ohne Bestätigungs-Angaben zu registrieren oder auszuführen. Im Zweifel gesperrt.
- **Bestätigungs-Protokoll.** Vor einer unumkehrbaren Aktion baut der Code des Werkzeugs die Vorschau aus den geprüften Argumenten, nie aus Text des Modells. Du siehst genau die Empfänger, den Text oder die Absender und den Rückweg. Serain handelt erst nach deinem 👍 (oder einem schlichten „ja“). Vorschauen laufen ab. Manche Werkzeuge erlauben eine Dauerfreigabe („ja immer“) für genau ein Ziel; `money` nie.
- **Ingress-Allowlist.** Nur deine Telefonnummer (`OWNER_PHONE`) erreicht das Modell. Gruppen und unbekannte Absender werden vor jedem Modell-Aufruf und vor jedem Werkzeug verworfen.
- **Kill-Switch.** Schreib `serain stop`, und alle Werkzeuge sind gesperrt, auch noch offene Bestätigungen, bis du `serain resume` schreibst. `serain stop` geht, egal in welcher Sprache du schreibst (das deutsche `serain stopp` und `serain weiter` gehen auch, ebenso die Wörter deiner aktuellen Sprache). `serain revoke` zieht jede Dauerfreigabe zurück. Die Wörter erkennt Code außerhalb des Modells, und der Zustand liegt in der Datenbank, damit ein Neustart ihn nicht aufhebt; ist der Zustand nicht lesbar, sperrt Serain sich selbst.
- **Fremder Inhalt.** Mails, Webseiten, Kalendereinträge und verbundene Dienste gelten als fremd. Hat ein Turn fremden Inhalt gelesen, nimmt er von diesem Inhalt keine neuen Anweisungen an; in verbundene Dienste schreiben darf nur ein sauberer Turn, den du ausgelöst hast, und Links gehen nur zu Seiten, die ein Werkzeug wirklich geöffnet hat.
- **Audit-Log.** Jeder Werkzeug-Aufruf, jede Bestätigung, jeder Kill-Switch und jede ausgehende Nachricht landet in einer Tabelle, an die nur angehängt wird. Private Ergebnisse (Mail-Inhalte, Kalendertitel, Bankdaten) stehen nie darin.
- **Geheimnisse.** Zugänge liegen versiegelt in der Datenbank, mit einem Schlüssel, der nur in der Umgebung des Servers steht; Tresor-Einträge versiegelt dein Browser an den öffentlichen Schlüssel des Servers. Kindprozesse (die Claude-CLI, Chrome) bekommen eine Umgebung nach Allowlist. Geheimnisse werden in Logs geschwärzt und erreichen nie einen Prompt.
- **Abschottung.** Der Dienst läuft als unprivilegierter Benutzer in einer gehärteten systemd-Unit. Die Sandbox läuft mit `--network none`, schreibgeschützt und ohne Capabilities, gestartet von einem eigenen, root-eigenen Helfer; der Dienst-Benutzer ist nicht in der Gruppe `docker`. Ausgehende Nachrichten sind mengenbegrenzt.

Einen Weg daran vorbei gefunden? Siehe [SECURITY.md](SECURITY.md).

## Was du brauchst

| | Baustein | Was er freischaltet |
|---|---|---|
| **Pflicht** | [Supabase](https://supabase.com)-Projekt (Free reicht) | Datenbank: Gedächtnis, Audit-Log, Bestätigungen, Aufträge |
| **Pflicht** | Linux-VM mit Docker (Ubuntu 24.04, ARM64 oder x86-64, mindestens 4 GB RAM, empfohlen 8 GB) | Betrieb von Serain, Sandbox und Browser |
| **Pflicht** | [Photon](https://photon.codes)-Konto (Free, geteilte Nummer) | Der iMessage-Kanal |
| **Pflicht** | Claude-Zugang: ein [Anthropic-API-Schlüssel](https://console.anthropic.com) (oder dein eigenes Abo-Token, siehe [Rechtliches](#rechtliches)) | Chat- und Executor-Modell |
| **Pflicht** | Ein Apple-Gerät mit iMessage für dich | Mit Serain schreiben |
| Optional | Webinterface: Cloudflare-Konto und eigene Domain | Audit-Log, Gedächtnis bearbeiten, Tresor (eingeloggte Sitzungen, Dateien), Verbindungen |
| Optional | Mac-Companion (macOS mit Xcode Command Line Tools) | Apple-Kalender, Erinnerungen, Kontakte, ein Browser mit deiner Heim-IP |
| Optional | Google-Cloud-OAuth-App (Testmodus) | Gmail und Google Kalender |
| Optional | App-spezifisches iCloud-Passwort | iCloud-Kalender über CalDAV |
| Optional | Beliebiges IMAP/SMTP-Postfach | Mails lesen, aufräumen und senden |
| Optional | Ein eigenes Postfach für Serain | Serain schreibt als es selbst, nie in deinem Namen |
| Optional | [OpenRouter](https://openrouter.ai)-API-Schlüssel | Fallback-Modell, semantische Suche im Gedächtnis (Embeddings), Videos (Gemini), eine gehostete Stimme für gesprochene Antworten |
| Optional | [Tavily](https://tavily.com)-API-Schlüssel | Web-Suche |
| Optional | Typesafe-API-Schlüssel | Browser-Pilot für mehrstufige Aufgaben im Web |
| Optional | [Enable Banking](https://enablebanking.com)-App (braucht das Webinterface) | Lesezugriff auf dein eigenes Bankkonto |
| Optional | COROS-Konto (braucht das Webinterface) | Schlaf, HRV, Trainingslast von deiner COROS-Uhr |
| Optional | [Healthchecks.io](https://healthchecks.io)-Check | Alarm außerhalb von iMessage, wenn Server oder Kanal ausfallen |

## Kosten

Gratis ist nur der Code. Alles andere ist dein eigenes Konto mit eigenen Bedingungen.

| Posten | Kosten |
|---|---|
| Serain | Gratis (AGPL-3.0) |
| Claude-API | Nach Tokens; hängt ganz davon ab, wie viel du Serain benutzt. Serain zählt sie gegen seinen Monatsdeckel (`SERAIN_API_BUDGET_USD`, Vorgabe 20 $) und hält bezahlte Aufrufe am Deckel an, auch den Chat (ab 80 % spart es: keine proaktiven Meldungen, günstigere Fallback-Modelle). Setz dasselbe Limit in der Anthropic Console als Absicherung. |
| Claude-Abo (Alternative) | Dein bestehendes persönliches Abo, siehe [Rechtliches](#rechtliches) |
| Supabase | Free reicht für einen Nutzer |
| Photon | Free mit geteilter Nummer |
| Server | Oracle Cloud Always Free kostet nichts, verlangt bei der Anmeldung aber eine Kreditkarte; jeder andere VPS ab 4 GB RAM geht auch (meist ein paar Euro im Monat) |
| Domain (nur fürs Webinterface) | Etwa 5 bis 15 € im Jahr; Cloudflare Workers, Access (bis 50 Nutzer) und Hyperdrive sind gratis |
| OpenRouter (optional) | Nach Verbrauch. Zählt gegen denselben Monatsdeckel; setz auch am Schlüssel ein Limit. Eine Stunde YouTube kostet etwa 0,17 $. |
| Tavily, Healthchecks.io, Enable Banking, Google Cloud | Die Gratis-Stufen reichen |
| Typesafe (optional) | Nach Verbrauch |

## Rechtliches

Keine Rechtsberatung. Dieser Abschnitt fasst zusammen, was der Autor beim Prüfen der Bedingungen aller beteiligten Dienste gefunden hat. Du betreibst deine eigene Instanz und bist dafür verantwortlich, wie du sie nutzt.

- **Claude Agent SDK.** Serain hängt von `@anthropic-ai/claude-agent-sdk` ab. Das SDK ist proprietär („All rights reserved“), es gelten Anthropics Bedingungen. Es wird als Abhängigkeit von npm installiert, nie in dieses Repository kopiert, und fällt nicht unter die AGPL.
- **Claude-Anmeldung.** Standard ist ein **Anthropic-API-Schlüssel**. Anthropics Dokumentation verlangt von Entwicklern die Anmeldung per API-Schlüssel und sieht die Abo-Anmeldung für die gewöhnliche Nutzung vor. Dein eigenes Abo-Token (`CLAUDE_CODE_OAUTH_TOKEN`) geht für den rein persönlichen Gebrauch, auf eigenes Risiko. Sammle, teile oder leite nie Tokens anderer weiter.
- **Namen.** Serain ist weder mit Anthropic noch mit Apple verbunden, von ihnen unterstützt oder gesponsert. „Claude“, „iMessage“ und verwandte Namen sind Marken ihrer Inhaber.
- **Photon.** Das Spectrum-SDK steht unter MIT. Der Dienst verlangt ein eigenes Konto, Weiterverkauf ist verboten. Bei Free ist die Nummer aus Photons Pool geteilt und gehört nicht dir; Photon kann sie wechseln. Deine Nachrichten laufen über Photons Infrastruktur und sind nicht auf jeder Strecke Ende-zu-Ende verschlüsselt; lies Photons Bedingungen und Datenschutzerklärung.
- **iMessage-Automatisierung** ist eine Grauzone. Apples iCloud-Bedingungen verbieten den Zugriff auf den Dienst mit automatisierten Mitteln. Nutze Serain nur für dich selbst; das Risiko, bis hin zum Verlust eines Apple-Kontos, liegt bei dir.
- **Google (Gmail, Kalender).** Jeder Nutzer legt seine eigene OAuth-App an. Im Testmodus laufen Refresh-Tokens nach 7 Tagen ab, du verbindest also wöchentlich neu. Eine geteilte Client-ID gibt es nicht: eine veröffentlichte App mit Gmail-Rechten braucht Googles Verifizierung und ein CASA-Sicherheitsaudit. Nutzer von Google Workspace können die App stattdessen auf „Intern“ stellen.
- **Video-Downloads (yt-dlp).** yt-dlp steht unter der Unlicense. Laden von TikTok, Instagram und X ist **standardmäßig aus** und nur mit `SERAIN_MEDIA_DOWNLOAD=1` an, auf eigenes Risiko; die Bedingungen der Plattformen verbieten Downloads in der Regel. YouTube wird nie geladen: Google AI Studio holt die öffentliche URL selbst. YouTubes AGB verbieten Downloads, und nach deutscher Rechtsprechung (OLG Hamburg, 5 U 54/23) verletzt das Umgehen von YouTubes technischem Schutz § 95a UrhG. Serain umgeht keine Bot-Sperren und meldet sich bei diesen Plattformen nicht an.
- **Gemini.** Videos wertet Gemini über OpenRouter aus. Alles außer YouTube geht nur an Endpunkte mit Zero Data Retention. YouTube geht an Google AI Studio, dort gibt es keine Zero Data Retention; dieser Aufruf trägt nur die öffentliche URL und eine feste Anweisung, nie deine Frage, nie etwas aus deinem Gedächtnis. Schalte Videos nicht ein, wenn das für dich nicht in Ordnung ist.
- **Enable Banking.** Gratis für den Zugriff auf eigene Konten, nur nicht kommerziell. Serain liest Kontostand und Umsätze; überweisen kann es nicht.
- **Datenschutz (DSGVO).** Betreibst du Serain für dich selbst, greift die Haushaltsausnahme (Art. 2 Abs. 2 lit. c DSGVO); der Autor dieses Codes ist nicht Verantwortlicher für deine Daten. Nutzt du Serain geschäftlich, bist du Verantwortlicher und für die Einhaltung zuständig, auch für die Daten aller, deren Mails und Termine Serain verarbeitet.

## Haftungsausschluss

Diese Software wird ohne jede Gewährleistung bereitgestellt, wie in den Abschnitten 15 und 16 der [Lizenz](LICENSE) festgehalten. Serain handelt mit echten Konten in deinem Auftrag: es liest deine Mails, schickt Nachrichten, ändert deinen Kalender und kann bei Drittanbietern Kosten verursachen. Du bist verantwortlich für die Einrichtung, für jede Aktion, die du bestätigst, und dafür, die Bedingungen jedes verbundenen Dienstes einzuhalten. Der Autor haftet nicht für Schäden, Kosten, verlorene Daten, gesperrte Konten oder rechtliche Folgen aus der Nutzung.

## Schnellstart

Die vollständige Anleitung in der Reihenfolge der Abhängigkeiten steht in [docs/SETUP.md](docs/SETUP.md) (Englisch); `pnpm setup:check` zeigt bei jedem Schritt, wo du stehst und was als Nächstes kommt. Ein Coding-Agent wie Claude Code oder Codex kann dich durchführen: Er folgt [AGENTS.md](AGENTS.md), und deine Schlüssel bleiben bei dir. Kurz:

1. Supabase-Projekt anlegen und `supabase/migrations/` mit `psql` anwenden.
2. Photon-Projekt anlegen (iMessage, Free) und einen Anthropic-API-Schlüssel erzeugen.
3. `cp .env.example .dev.vars` und die Pflichtwerte eintragen (`OWNER_NAME`, `OWNER_PHONE`, `OWNER_TIMEZONE`, Photon, Supabase, Claude).
4. Eine Ubuntu-24.04-VM mit `deploy/provision.sh` einrichten, die Geheimnisse übertragen, `pnpm db:password` ausführen.
5. Den Kanal lokal mit `SERAIN_ECHO_ONLY=1 pnpm dev` testen, dann mit `./deploy/deploy.sh` ausrollen.
6. Deiner Photon-Nummer „hi“ schreiben.
7. Optional Serain erzählen, wer du bist: `cp -r data.example data`, über dich schreiben, `pnpm memory:push --apply`.

## Entwicklung

```bash
pnpm install
pnpm typecheck                    # Server, Web-Worker und Web-Client
pnpm test                         # Unit-, Integrations- und Fuzz-Tests (fester Seed)
pnpm fuzz                         # 2.000 Fuzz-Fälle
pnpm dev                          # lokal gegen deine .dev.vars
SERAIN_ECHO_ONLY=1 pnpm dev       # Echo statt Modell: testet den Kanal ohne Kosten
pnpm web:dev                      # Webinterface auf http://localhost:8787
pnpm web:e2e                      # Ende-zu-Ende-Test des Webinterfaces (Wegwerf-Datenbank)
pnpm eval --list                  # Evals für Prompts und Modelle (echte Modell-Aufrufe, kosten Geld)
```

Es darf immer nur **ein** Prozess mit Photon verbunden sein. Läuft der Dienst auf dem Server, vor `pnpm dev` erst `systemctl stop serain`, sonst bekommen beide jede Nachricht und du zwei Antworten.

Tests berühren nie echte Konten: `vitest.config.ts` setzt für jeden Zugang eine Attrappe. Evals spielen den erfundenen Besitzer „Alex“ (`eval/persona.ts`) und rufen echte Modelle mit deinen Schlüsseln auf; Änderungen an Prompts oder Stil brauchen eine. Code, Kommentare und Prompts sind auf Englisch.

## Projektstruktur

```
src/agent/        Modell-Layer (Claude Agent SDK, OpenRouter als Fallback), Prompts, Werkzeuge, Turns
src/channel/      Channel-Interface und der Photon-Adapter
src/security/     Allowlist, Kill-Switch, Bestätigungen, fremder Inhalt, Link-Prüfung
src/db/           Zugriff auf Supabase und Postgres, Audit-Log
src/memory/       Fakten, Nutzermodell, Embeddings, Vorgehensweisen
src/mail/         IMAP/SMTP und Gmail, Aufräumen, Fundstücke
src/calendar/     CalDAV und Google Kalender
src/executor/     der Executor: Web-Recherche und Browser
src/browser/      Chrome auf dem Server
src/connectors/   verbundene Dienste (Katalog und Treiber)
src/sandbox/      Client für den Helfer der Docker-Sandbox
src/scheduler/    Erinnerungen, Aufträge, Wächter
src/health/       Heartbeat, Wächter, Deadman-Switch
src/config/       Umgebung, Besitzer, Modelle, Grenzen
src/i18n/         Sprachen: Erkennung, Katalog fester Texte, Wörter, die der Code liest
web/              Webinterface (Cloudflare Worker und Client)
site/             serain.si, die Website des Projekts mit dem Connector-Verzeichnis
companion/        Mac-Companion
deploy/           Einrichtung, Ausrollen, systemd-Units, Sandbox-Image
supabase/         Migrationen
test/             Tests, auch test/fuzz
eval/             Evals für Modelle und Prompts
scripts/          Befehle für Einrichtung und Pflege
instance/         deine eigenen Ergänzungen, außerhalb des Repos (docs/INSTANCE.md)
data.example/     Vorlage für dein eigenes Grundwissen (nach data/ kopieren, gitignored)
```

## Stand

Serain ist in einem frühen Stadium. Jede Instanz hat genau einen Besitzer. Der Agent spricht jede Sprache, in der du schreibst. Sein Stil-Prompt ist auf Englisch; Änderungen daran laufen über die Chat-Eval (`pnpm eval`).

Roadmap:

- Einfachere Einrichtung: ein Setup-Skript und ein Weg, das Webinterface ohne eigene Domain zu betreiben.
- Feiertage für weitere Länder (bisher nur Deutschland).
- Weitere Stimmen für gesprochene Antworten.

## Mitwirken

Beiträge sind willkommen, solange sie zum Rahmen passen: ein selbst gehosteter Agent für einen Besitzer. Lies zuerst [CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken bitte privat melden, siehe [SECURITY.md](SECURITY.md). Es gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md).

## Lizenz

Copyright (C) 2026 Valentin Weinert

Serain ist freie Software: du kannst sie unter den Bedingungen der [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`), wie von der Free Software Foundation veröffentlicht, weitergeben und ändern. Sie wird ohne jede Gewährleistung verbreitet; Einzelheiten stehen in der Lizenz. Du darfst Serain nutzen, untersuchen, ändern und weitergeben. Betreibst du eine geänderte Fassung als Netzwerkdienst für andere, musst du ihnen den Quellcode unter derselben Lizenz anbieten. Der Sinn: niemand kann Serain als geschlossenen gehosteten Dienst weiterbetreiben.

Nicht mit Anthropic oder Apple verbunden.
