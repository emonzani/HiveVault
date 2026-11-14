import { describe, expect, it } from "vitest";
import { documentCodes, shortForms } from "../src/index.ts";

describe("document codes", () => {
  it("takes the code before the title of a standard, and the issuer the text writes before it", () => {
    const title = "EN 319 522-2 - V1.2.1 - Electronic Signatures and Infrastructures (ESI); Electronic Registered Delivery Services; Part 2: Semantic contents";
    const text = "ETSI EN 319 522-2 V1.2.1 (2024-01) Electronic Signatures and Infrastructures (ESI) EUROPEAN STANDARD";
    expect(documentCodes(title, text)).toEqual(["EN 319 522-2", "ETSI EN 319 522-2"]);
  });

  it("does not take the code of another part named in the text", () => {
    const title = "EN 319 522-4-2 - V1.1.1 - Electronic Registered Delivery Services; Part 4: Bindings";
    const text = "See ETSI EN 319 522-1 and ETSI EN 319 522-4-2V1.1.1. Also ETSI EN 319 522-4-2 V1.1.1.";
    expect(documentCodes(title, text)).toEqual(["EN 319 522-4-2", "ETSI EN 319 522-4-2"]);
  });

  it("keeps an issuer already in the title and adds the short form", () => {
    expect(documentCodes("UNI EN ISO 9001 - Sistemi di gestione per la qualità", "")).toEqual(["UNI EN ISO 9001", "EN ISO 9001", "ISO 9001"]);
  });

  it("gives nothing for titles that are not a code", () => {
    expect(documentCodes("Verbale della riunione - marzo", "")).toEqual([]);
    expect(documentCodes("Contratto 2024 - Acme", "")).toEqual([]); // "Contratto 2024" is a title, not a code
    expect(documentCodes("ETSI EN 319 522-1", "ETSI EN 319 522-1")).toEqual([]); // the title is already the code
    expect(documentCodes("RFC 2045 - MIME Part One", "")).toEqual(["RFC 2045"]);
  });

  it("short forms still drop the issuing bodies", () => {
    expect(shortForms("ETSI EN 319 522-2")).toEqual(["EN 319 522-2"]);
  });
});
