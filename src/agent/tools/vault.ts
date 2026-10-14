import { z } from "zod";
import { formatSize } from "../../files/name.js";
import type { FileShelf } from "../../files/shelf.js";
import { VaultFileUnavailable, type VaultFiles } from "../../files/vault.js";
import { VAULT_FILE_MAX_BYTES, VAULT_FILE_NAME } from "../../vault/file.js";
import type { FilePort } from "./files.js";
import { defineTool, type ToolDefinition } from "./types.js";
import { owner } from "../../config/owner.js";
import { t } from "../../i18n/catalog.js";
import { tools as messages } from "../../i18n/messages/tools.js";

/**
 * Files from the owner's vault (addendum D49 of 2026-10-08): ID card,
 * certificates, contracts the owner stored in the web interface.
 *
 * **Serain never knows the content.** As with files the owner sends via
 * iMessage (addendum D34), the model sees name, size and an ID. The file goes
 * either to the owner or onto the shelf from which `mail_send` attaches it;
 * there it is in the preview, comes along in the thread below it, and a
 * standing approval never applies to mails with attachments. There is no
 * other way out.
 *
 * **Only when the owner asks in this turn** (`ownerOriginOnly`): no heartbeat,
 * no calendar event, no mail and no task opens the owner's ID card. Every
 * opening is in the audit log under security.
 */

export function vaultFileTools(deps: { files: VaultFiles; shelf: FileShelf; port: FilePort | null }): ToolDefinition[] {
  const names = async (): Promise<string> => {
    const list = await deps.files.list().catch(() => null);
    if (!list) return "";
    return list.length > 0 ? ` In the vault: ${list.map((file) => file.name).join(", ")}.` : " There are no files in the vault.";
  };

  return [
    defineTool({
      name: "vault_files",
      description:
        `Lists the files in ${owner.name}'s vault: documents they stored themselves in the web interface (ID card, ` +
        "certificates, contracts). Name, file name, size. You do not know the content.",
      level: "read",
      repeatable: true,
      privateResult: true,
      schema: {},
      async run() {
        let list;
        try {
          list = await deps.files.list();
        } catch {
          return { ok: false, text: `The vault cannot be read right now. Tell ${owner.name}, instead of trying again.` };
        }
        if (list.length === 0) return { ok: true, text: `There are no files in the vault. Only ${owner.name} can store them, in the web interface.` };
        return {
          ok: true,
          text: list.map((file) => `${file.name}: "${file.filename}", ${formatSize(file.size)}, stored ${file.updatedAt.toISOString().slice(0, 10)}`).join("\n"),
        };
      },
    }),

    defineTool({
      name: "vault_file",
      description:
        `Fetches a file from ${owner.name}'s vault, only when ${owner.name} asks for it in this message. send_to_owner sends it to them ` +
        "via iMessage (\"send me my ID card\"). Without send_to_owner you only get the ID with which mail_send " +
        `attaches it ("send my ID card to …"); ${owner.name} then sees it in the preview. You do not know the content.`,
      // Like send_file: can send to the owner, and only to the owner.
      level: "write_reversible",
      ownerOriginOnly: true,
      schema: {
        name: z.string().trim().toLowerCase().regex(VAULT_FILE_NAME).describe("Name of the file in the vault, from vault_files, e.g. id-card."),
        send_to_owner: z.boolean().default(false),
      },
      async run(args, turn) {
        if (args.send_to_owner && !deps.port) return { ok: false, text: `The channel cannot send files right now. Tell ${owner.name}.` };
        let opened;
        try {
          opened = await deps.files.open(args.name);
        } catch (error) {
          if (error instanceof VaultFileUnavailable) return { ok: false, text: error.message };
          return { ok: false, text: `The vault cannot be read right now. Tell ${owner.name}, instead of trying again.` };
        }
        if (!opened) return { ok: false, text: `"${args.name}" is not in the vault.${await names()} Only ${owner.name} can store files, in the web interface.` };
        const file = deps.shelf.put({ name: opened.filename, mimeType: opened.mimeType, body: opened.body });
        const note = `[File from the vault: "${file.name}", ${formatSize(file.size)}. You do not know the content. To attach: mail_send with files ["${file.id}"]]`;
        if (!args.send_to_owner) return { ok: true, text: note };
        if (!turn.claimMessage()) return { ok: false, text: `Message limit for this turn reached. ${note}` };
        const sent = await deps.port!.sendFile(
          { name: file.name, mimeType: file.mimeType, body: file.body },
          t(messages.vaultCaption),
          { kind: "vault_file", origin: turn.origin, taintSources: [...turn.taintSources], maxBytes: VAULT_FILE_MAX_BYTES },
        );
        return sent
          ? { ok: true, text: `${file.name} is with ${owner.name}. ${note}` }
          : { ok: false, text: `Not sent (channel does not accept the file, limit, or just sent already). Tell ${owner.name}. ${note}` };
      },
    }),
  ];
}
