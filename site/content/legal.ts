import { LICENSE_URL, REPO, submitPath, type Lang } from "./site.js";

/**
 * Imprint and privacy notice of serain.si (D65), in English and German. The
 * wording follows the maintainer's own legal pages; it describes what this
 * site actually does (site/worker/worker.ts, site/worker/analytics.ts), so a
 * change to the Worker, the counting or the client script changes this text.
 *
 * Address, phone, email and VAT ID are not in the repository: the build reads
 * them from `.dev.vars` (site/legal.ts).
 *
 * Paragraphs know three marks, rendered the same in the HTML and in the
 * Markdown twin: `[label](href)`, `**strong**` and `` `code` ``.
 */

export interface Imprint {
  name: string;
  street: string;
  /** Postal code and city. */
  city: string;
  phone: string;
  email: string;
  vatId: string;
}

export interface LegalSection {
  heading: string;
  /** Lines of a postal address, shown before the paragraphs. */
  address?: string[];
  paragraphs: string[];
}

export interface LegalPage {
  title: string;
  description: string;
  heading: string;
  intro?: string;
  sections: LegalSection[];
}

const COUNTRY: Record<Lang, string> = { en: "Germany", de: "Deutschland" };
const mail = (email: string) => `[${email}](mailto:${email})`;
const tel = (phone: string) => `[${phone}](tel:${phone.replace(/[^+\d]/g, "")})`;
const postal = (imprint: Imprint, lang: Lang) => [imprint.name, imprint.street, imprint.city, COUNTRY[lang]];

export function imprintPage(lang: Lang, imprint: Imprint): LegalPage {
  if (lang === "de") {
    return {
      title: "Impressum · Serain",
      description: "Angaben gemäß § 5 DDG.",
      heading: "Impressum",
      sections: [
        { heading: "Angaben gemäß § 5 DDG", address: postal(imprint, lang), paragraphs: [] },
        { heading: "Kontakt", paragraphs: [`Telefon: ${tel(imprint.phone)}`, `E-Mail: ${mail(imprint.email)}`] },
        { heading: "Umsatzsteuer-Identifikationsnummer", paragraphs: [`Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: **${imprint.vatId}**`] },
        { heading: "Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV", paragraphs: [`${imprint.name} (Anschrift wie oben).`] },
        {
          heading: "Verbraucherstreitbeilegung",
          paragraphs: ["Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen (§ 36 VSBG)."],
        },
        {
          heading: "Haftung für Inhalte",
          paragraphs: [
            "Als Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG sind wir nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt.",
          ],
        },
        {
          heading: "Haftung für Links",
          paragraphs: [
            "Diese Seite enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber verantwortlich; wir übernehmen für deren Inhalte keine Gewähr.",
          ],
        },
        {
          heading: "Lizenz",
          paragraphs: [
            `Serain und diese Website sind Open Source unter der [GNU Affero General Public License 3.0](${LICENSE_URL}); der Quellcode liegt auf [GitHub](${REPO}). Logos und Marken Dritter gehören ihren Inhabern.`,
          ],
        },
      ],
    };
  }
  return {
    title: "Imprint · Serain",
    description: "Legal notice under § 5 DDG.",
    heading: "Imprint",
    sections: [
      { heading: "Information according to § 5 DDG", address: postal(imprint, lang), paragraphs: [] },
      { heading: "Contact", paragraphs: [`Phone: ${tel(imprint.phone)}`, `Email: ${mail(imprint.email)}`] },
      { heading: "VAT identification number", paragraphs: [`Sales-tax identification number under § 27a UStG: **${imprint.vatId}**`] },
      { heading: "Responsible for content under § 18 (2) MStV", paragraphs: [`${imprint.name} (address as above).`] },
      {
        heading: "Consumer dispute resolution",
        paragraphs: ["We are neither obliged nor willing to participate in dispute resolution proceedings before a consumer arbitration board (§ 36 VSBG)."],
      },
      {
        heading: "Liability for content",
        paragraphs: [
          "As a service provider, we are responsible for our own content on these pages in accordance with general laws (§ 7 (1) DDG). Pursuant to §§ 8 to 10 DDG, we are not obliged to monitor transmitted or stored third-party information or to investigate circumstances that indicate illegal activity. Obligations to remove or block the use of information under general laws remain unaffected.",
        ],
      },
      {
        heading: "Liability for links",
        paragraphs: [
          "This site contains links to external third-party websites whose content we cannot influence. We therefore accept no liability for these external contents. The respective provider or operator of the linked pages is always responsible for their content.",
        ],
      },
      {
        heading: "License",
        paragraphs: [
          `Serain and this website are open source under the [GNU Affero General Public License 3.0](${LICENSE_URL}); the source code is on [GitHub](${REPO}). Third-party logos and trademarks belong to their owners.`,
        ],
      },
    ],
  };
}

export function privacyPage(lang: Lang, imprint: Imprint): LegalPage {
  const controller = { address: postal(imprint, lang), paragraphs: [mail(imprint.email)] };
  if (lang === "de") {
    return {
      title: "Datenschutz · Serain",
      description: "Datenschutzerklärung gemäß DSGVO.",
      heading: "Datenschutzerklärung",
      intro: "Informationen zur Verarbeitung personenbezogener Daten auf serain.si gemäß Art. 13 und 14 der Verordnung (EU) 2016/679 (Datenschutz-Grundverordnung, „DSGVO“).",
      sections: [
        { heading: "Verantwortlicher", ...controller },
        {
          heading: "Geltungsbereich",
          paragraphs: [
            "Diese Erklärung gilt für die Website unter `serain.si`. Serain selbst läuft auf den Servern derer, die es einrichten; diese Website hat keinen Zugriff auf solche Instanzen. Für verlinkte Angebote wie GitHub gelten deren eigene Datenschutzerklärungen.",
          ],
        },
        {
          heading: "Hosting und Server-Logs",
          paragraphs: [
            "Diese Website wird über das Netzwerk und die Workers-Plattform der Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA („Cloudflare“) gehostet und ausgeliefert. Cloudflare ist als Auftragsverarbeiterin gemäß Art. 28 DSGVO für uns tätig; ein Auftragsverarbeitungsvertrag (Cloudflare Data Processing Addendum) liegt vor. Beim Aufruf der Seite verarbeitet Cloudflare automatisch technische Informationen und speichert sie teilweise in Logfiles: IP-Adresse, aufgerufene URL, HTTP-Methode, Statuscode, Antwortgröße, User-Agent, Referrer und Zeitpunkt der Anfrage. Dies ist erforderlich, um die Anfrage auszuliefern, Fehler zu erkennen und die Website vor Angriffen und Missbrauch zu schützen.",
            "Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse liegt im sicheren, stabilen Betrieb der Website und in der Abwehr von Missbrauch. Speicherdauer: Log-Einträge werden nur so lange gespeichert, wie es zur Erreichung dieses Zwecks erforderlich ist.",
            "Internationale Übermittlungen: Daten können in die USA übermittelt bzw. dort verarbeitet werden. Grundlage der Übermittlung sind der EU–U.S. Data Privacy Framework (Angemessenheitsbeschluss der EU-Kommission vom 10.07.2023; im September 2025 vom Gericht der Europäischen Union bestätigt) sowie ergänzend EU-Standardvertragsklauseln nach Art. 46 Abs. 2 lit. c DSGVO.",
          ],
        },
        {
          heading: "Zählung der Seitenaufrufe",
          paragraphs: [
            "Der Server dieser Website zählt Seitenaufrufe in Cloudflare Workers Analytics Engine, nicht im Browser. Je Aufruf werden nur grobe Kategorien gespeichert: die aufgerufene Seite, die Art der Anfrage, die Sprache der Seite, die Art des Clients (Browser, Suchmaschine, KI-Assistent oder -Crawler, Linkvorschau, sonstiger Bot), bei bekannten Crawlern deren Name, der Host einer verweisenden fremden Website und das Land, aus dem die Anfrage kommt. Nicht gespeichert werden die IP-Adresse (auch nicht gehasht), der vollständige User-Agent und Parameter in der Adresse. Gezählt werden Aufrufe, nicht Personen; einzelne Besucher lassen sich damit weder erkennen noch wiedererkennen. Die Einträge werden nach drei Monaten gelöscht.",
            "Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse liegt darin zu erfahren, welche Seiten gelesen werden und wie Suchmaschinen und KI-Assistenten die Website finden.",
          ],
        },
        {
          heading: "Cookies und vergleichbare Technologien",
          paragraphs: [
            "Diese Website setzt keine Cookies. Sie speichert keine Informationen auf Ihrem Endgerät und greift nicht auf dort gespeicherte Informationen zu: kein localStorage und keine vergleichbaren clientseitigen Speichertechnologien.",
          ],
        },
        {
          heading: "Schriftarten und eingebundene Dateien",
          paragraphs: [
            "Die Schriftart Instrument Serif wird selbst gehostet. Auch Skript, Stylesheet, Bilder und Logos kommen vom selben Origin wie diese Website. Zur Laufzeit wird keine Verbindung zu Drittanbietern (z. B. Google Fonts) aufgebaut.",
          ],
        },
        {
          heading: "Analyse und Tracking",
          paragraphs: [
            "Im Browser läuft kein Analyse-, Tracking-, Werbe- oder A/B-Test-Werkzeug und kein Fingerprinting. Es findet keine Datenweitergabe an Werbenetzwerke oder soziale Plattformen statt.",
          ],
        },
        {
          heading: "Connector vorschlagen",
          paragraphs: [
            `Das Formular unter [Connector vorschlagen](${submitPath(lang)}) sendet nichts an uns. Beim Absenden öffnet Ihr Browser die Seite für ein neues Issue im GitHub-Repository von Serain und übergibt die eingegebenen Angaben in der Adresse; dort prüfen Sie sie, bevor Sie das Issue mit Ihrem GitHub-Konto veröffentlichen. Ab diesem Schritt gilt die Datenschutzerklärung von GitHub.`,
          ],
        },
        {
          heading: "E-Mail-Kontakt",
          paragraphs: [
            "Wenn Sie uns per E-Mail kontaktieren, werden die übermittelten Daten (E-Mail-Adresse, Nachricht und etwaige Anhänge) ausschließlich zur Bearbeitung Ihrer Anfrage verarbeitet. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO bei vor- oder vertraglichem Bezug, ansonsten Art. 6 Abs. 1 lit. f DSGVO. Nachrichten werden so lange aufbewahrt, wie es zur Bearbeitung erforderlich ist und gesetzliche Aufbewahrungspflichten bestehen.",
          ],
        },
        {
          heading: "Ausgehende Links",
          paragraphs: [
            "Externe Links auf dieser Seite (z. B. zu GitHub) führen zu Angeboten anderer Anbieter. Ihr Browser übermittelt dabei nur die Adresse dieser Website (`https://serain.si`), nicht die Unterseite. Ab dem Folgen eines solchen Links gelten die Datenschutzerklärungen des jeweiligen Zielangebots.",
          ],
        },
        {
          heading: "Datensicherheit",
          paragraphs: [
            "Alle Verbindungen zu dieser Website sind TLS-verschlüsselt (HTTPS); die Verbindung wird automatisch hochgestuft (HSTS). Auf jeder Antwort werden gängige Security-Header gesetzt, darunter eine Content Security Policy, die nur Dateien vom eigenen Origin zulässt.",
          ],
        },
        {
          heading: "Ihre Rechte",
          paragraphs: [
            "Sie haben nach der DSGVO das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18) und Datenübertragbarkeit (Art. 20). Zudem können Sie **jederzeit Widerspruch gegen eine auf berechtigte Interessen gestützte Verarbeitung** einlegen (Art. 21). Soweit eine Verarbeitung auf einer Einwilligung beruht, können Sie diese jederzeit mit Wirkung für die Zukunft widerrufen.",
            `Zur Ausübung dieser Rechte genügt eine E-Mail an ${mail(imprint.email)}.`,
            "Es besteht zudem ein Beschwerderecht bei einer Aufsichtsbehörde (Art. 77 DSGVO). Zuständig ist der Hessische Beauftragte für Datenschutz und Informationsfreiheit (HBDI), Wiesbaden.",
          ],
        },
        {
          heading: "Änderungen dieser Erklärung",
          paragraphs: ["Diese Erklärung kann angepasst werden, wenn sich Funktionen der Website oder die Rechtslage ändern. Die aktuelle Fassung ist jeweils unter dieser URL verfügbar."],
        },
      ],
    };
  }
  return {
    title: "Privacy · Serain",
    description: "Privacy notice under the GDPR.",
    heading: "Privacy",
    intro: "Information on the processing of personal data on serain.si pursuant to Articles 13 and 14 of Regulation (EU) 2016/679 (General Data Protection Regulation, “GDPR”).",
    sections: [
      { heading: "Controller", ...controller },
      {
        heading: "Scope",
        paragraphs: [
          "This notice covers the website at `serain.si`. Serain itself runs on the servers of the people who set it up; this website has no access to such instances. Linked services such as GitHub have their own privacy notices.",
        ],
      },
      {
        heading: "Hosting and server log files",
        paragraphs: [
          "The website is hosted and delivered via the network and Workers platform of Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA (“Cloudflare”), acting as our processor under Article 28 GDPR. A Data Processing Agreement (the Cloudflare Data Processing Addendum) is in place. When you access the site, Cloudflare automatically processes technical information and partly stores it in log files: IP address, requested URL, HTTP method, status code, response size, user agent, referrer, and the time of the request. This is required to deliver the response, detect errors, and protect the site against attacks and abuse.",
          "Legal basis: Article 6 (1) (f) GDPR. Our legitimate interest is the secure, stable operation of the site and the defence against abuse. Retention: log entries are kept only for the period required for that purpose.",
          "International transfers: data may be processed in or transferred to the United States. The transfer is based on the EU–U.S. Data Privacy Framework (Commission adequacy decision of 10 July 2023; upheld by the General Court in September 2025) and, additionally, on Standard Contractual Clauses under Article 46 (2) (c) GDPR.",
        ],
      },
      {
        heading: "Counting page views",
        paragraphs: [
          "The website's server counts page views in Cloudflare Workers Analytics Engine, not in the browser. For each view only coarse categories are stored: the page, the kind of request, the page's language, the class of client (browser, search engine, AI assistant or crawler, link preview, other bot), the name of a known crawler, the host of a referring third-party website, and the country the request comes from. The IP address (not even hashed), the full user agent and parameters in the address are not stored. Views are counted, not people; individual visitors can neither be identified nor recognised. Entries are deleted after three months.",
          "Legal basis: Article 6 (1) (f) GDPR. Our legitimate interest is learning which pages are read and how search engines and AI assistants find the website.",
        ],
      },
      {
        heading: "Cookies and similar technologies",
        paragraphs: [
          "This website sets no cookies. It does not store information on your terminal equipment and does not access information stored there: no localStorage and no comparable client-side storage technologies are used.",
        ],
      },
      {
        heading: "Fonts and embedded files",
        paragraphs: [
          "The Instrument Serif typeface is self-hosted. Script, stylesheet, images and logos also come from the same origin as this website. No connection to third parties (such as Google Fonts) is established at runtime.",
        ],
      },
      {
        heading: "Analytics and tracking",
        paragraphs: [
          "No analytics, tracking, advertising or A/B testing tool and no fingerprinting runs in the browser. No data is shared with advertising networks or social platforms.",
        ],
      },
      {
        heading: "Suggesting a connector",
        paragraphs: [
          `The form at [Submit a connector](${submitPath(lang)}) sends nothing to us. When you submit it, your browser opens the page for a new issue in Serain's GitHub repository and passes what you entered in the address; you review it there before publishing the issue with your GitHub account. From that step on, GitHub's privacy notice applies.`,
        ],
      },
      {
        heading: "Email contact",
        paragraphs: [
          "If you contact us by email, the information you provide (email address, message, and any attachments) is processed solely to handle your enquiry. Legal basis: Article 6 (1) (b) GDPR for pre-contractual or contractual communication, otherwise Article 6 (1) (f) GDPR. Messages are retained for as long as required to address the matter and to comply with statutory retention obligations.",
        ],
      },
      {
        heading: "Outbound links",
        paragraphs: [
          "External links on this site (for example to GitHub) lead to services of other providers. Your browser only passes on the address of this website (`https://serain.si`), not the page. Once you follow such a link, the privacy notice of the destination website applies.",
        ],
      },
      {
        heading: "Data security",
        paragraphs: [
          "All connections to this website are encrypted with TLS (HTTPS) and the connection is upgraded automatically (HSTS). Industry-standard security headers are set on every response, among them a Content Security Policy that allows only files from the site's own origin.",
        ],
      },
      {
        heading: "Your rights",
        paragraphs: [
          "Under the GDPR, you have the right to request access (Article 15), rectification (Article 16), erasure (Article 17), restriction of processing (Article 18), and data portability (Article 20). You may also **object to processing based on legitimate interests** at any time (Article 21). Where processing is based on consent, you may withdraw it at any time with effect for the future.",
          `To exercise any of these rights, contact us at ${mail(imprint.email)}.`,
          "You also have the right to lodge a complaint with a supervisory authority (Article 77 GDPR). The competent authority for the controller is the Hessian Commissioner for Data Protection and Freedom of Information (HBDI), Wiesbaden.",
        ],
      },
      {
        heading: "Changes to this notice",
        paragraphs: ["We may update this notice to reflect changes to the website or to applicable law. The current version is always available at this URL."],
      },
    ],
  };
}
