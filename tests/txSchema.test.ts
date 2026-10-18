import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import {
  editTxnSchema,
  reviewTxnSchema,
  verifyTxnSchema,
} from "../src/middlewares/validation";
import { Tx } from "../src/models/txModel";
import { Notification } from "../src/models/notificationModel";

const hex = () => new mongoose.Types.ObjectId().toHexString();
const TS = "2026-10-17T10:00:00.000Z";

describe("tx schemas: expectedUpdatedAt", () => {
  it("editTxnSchema keeps expectedUpdatedAt", () => {
    const out = editTxnSchema.parse({
      params: { txnId: hex() },
      body: { amount: 1500, expectedUpdatedAt: TS },
    });
    expect(out.body.expectedUpdatedAt).toBe(TS);
  });

  it("editTxnSchema rejects a non-ISO expectedUpdatedAt", () => {
    const res = editTxnSchema.safeParse({
      params: { txnId: hex() },
      body: { amount: 1500, expectedUpdatedAt: "yesterday" },
    });
    expect(res.success).toBe(false);
  });

  it("reviewTxnSchema keeps expectedUpdatedAt", () => {
    const out = reviewTxnSchema.parse({
      body: { txnId: hex(), action: "verify", expectedUpdatedAt: TS },
    });
    expect(out.body.expectedUpdatedAt).toBe(TS);
  });

  it("verifyTxnSchema keeps expectedUpdatedAt", () => {
    const out = verifyTxnSchema.parse({
      body: { txnId: hex(), expectedUpdatedAt: TS },
    });
    expect(out.body.expectedUpdatedAt).toBe(TS);
  });
});

describe("Tx model edit tracking", () => {
  it("defaults editCount to 0 and leaves editedAt undefined", () => {
    const tx = new Tx({
      chatId: hex(),
      amount: 100,
      date: new Date(),
      to: hex(),
      from: hex(),
      addedBy: hex(),
    });
    expect(tx.validateSync()).toBeUndefined();
    expect(tx.editCount).toBe(0);
    expect(tx.editedAt).toBeUndefined();
  });
});

describe("Notification type enum", () => {
  it("includes txn_edited", () => {
    const values = (Notification.schema.path("type") as any).enumValues;
    expect(values).toContain("txn_edited");
  });
});
