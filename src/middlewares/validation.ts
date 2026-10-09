import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { compareVersions } from "../utils/semver.js";

//======= Shared primitives =======//
//
// Defined once so every endpoint agrees on what an id, an amount, and a date
// are. Zod objects strip unknown keys by default, and `validate()` now assigns
// the parsed result back onto the request — which means these schemas double as
// mass-assignment protection: a field not named here cannot reach a handler,
// and therefore cannot reach Mongoose.

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid id");

/**
 * A monetary amount.
 *
 * `coerce` accepts the string "100" from older clients and turns it into the
 * number 100 *before* any handler sees it. That is the fix for the ledger
 * corruption where `ledger.totalExpenses += amount` evaluated `50 + "100"` as
 * the string "50100".
 *
 * `.finite()` rejects NaN and Infinity — the mobile client's `parseFloat("abc")`
 * produced NaN, which serialises to JSON `null` and silently poisoned sums.
 */
export const money = z.coerce
  .number()
  .finite("Amount must be a number")
  .positive("Amount must be greater than 0")
  .max(10_000_000, "Amount must be less than 1,00,00,000")
  // Money is stored in rupees as a float; round at the boundary so accumulated
  // sub-paisa fractions cannot drift the ledger over time.
  .transform((n) => Math.round(n * 100) / 100);

export const isoDate = z
  .string()
  .datetime({ offset: true, message: "Invalid date (ISO 8601 required)" });

export const shortText = (max: number, label = "Text") =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer`);

/** Cursor pagination query shared by transactions, expenses and pool txns. */
export const paginationQuery = z.object({
  cursor: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

//======= Validation Schemas =======//

export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required").trim(),
    phone: z
      .string()
      .regex(
        /^\+?[1-9]\d{1,14}$/,
        "Invalid phone number format (use E.164 format)",
      ),
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters"),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number"),
    password: z.string().min(1, "Password is required"),
  }),
});

export const addTxnSchema = z.object({
  body: z.object({
    chatId: objectId,
    amount: money,
    date: isoDate,
    remarks: shortText(200, "Remarks").optional(),
    to: objectId,
    from: objectId,
  }),
});

/**
 * Editing a transaction. `to`/`from` are accepted but the handler re-runs
 * participant validation against them — previously `editTxn` assigned them
 * straight onto the document with no schema on the route at all, so arbitrary
 * user ids could be written into a ledger and into MonthlySummary.
 */
export const editTxnSchema = z.object({
  params: z.object({ txnId: objectId }),
  body: z.object({
    amount: money.optional(),
    date: isoDate.optional(),
    remarks: shortText(200, "Remarks").optional(),
    to: objectId.optional(),
    from: objectId.optional(),
  }),
});

export const txnIdParamSchema = z.object({
  params: z.object({ txnId: objectId }),
});

export const getTxnsSchema = z.object({
  params: z.object({ chatId: objectId }),
  query: paginationQuery,
});

export const verifyTxnSchema = z.object({
  body: z.object({ txnId: objectId }),
});

export const reviewTxnSchema = z.object({
  body: z.object({
    txnId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid txnId"),
    action: z.enum(["verify", "reject"]).default("verify"),
    remark: z.string().max(200, "Remark too long").optional(),
  }),
});

export const checkContactsSchema = z.object({
  body: z.object({
    phoneNumbers: z
      .array(z.string())
      .max(200, "Maximum 200 contacts per request")
      .min(1, "At least one phone number required"),
  }),
});

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(1).trim().optional(),
    avatar: z.string().url("Invalid avatar URL").optional(),
  }),
});

export const updatePushTokenSchema = z.object({
  body: z.object({
    pushToken: z
      .string()
      .startsWith("ExponentPushToken[", "Invalid Expo push token format"),
  }),
});

export const sendOtpSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    otp: z.string().length(6, "OTP must be 6 digits"),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    otp: z.string().length(6, "OTP must be 6 digits"),
    newPassword: z.string().min(6, "Password must be at least 6 characters"),
  }),
});

export const changePasswordSchema = z.object({
  body: z.object({
    oldPassword: z.string().min(1, "Old password is required"),
    newPassword: z
      .string()
      .min(6, "New password must be at least 6 characters"),
  }),
});

export const verifyEmailSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    otp: z.string().length(6, "OTP must be 6 digits"),
  }),
});

//======= Middleware Factory =======//

/**
 * Zod validation middleware factory
 * Usage: validate(registerSchema)
 */
export const validate = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };

      /**
       * Assign the PARSED result back onto the request.
       *
       * Previously the return value was discarded and only the throw was used,
       * which made every `.default()`, `.trim()`, `.toLowerCase()` and coercion
       * in every schema inert: handlers still received the raw body. Routes
       * were checked but never sanitised — so `amount: "100"` passed a
       * `z.number()` check nowhere and reached `ledger.total += amount` as a
       * string, producing `50 + "100" === "50100"`.
       *
       * `req.query` and `req.params` are getter-only on Express 5, so they are
       * mutated in place rather than reassigned.
       */
      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }
      if (parsed.query !== undefined) {
        Object.assign(req.query, parsed.query);
      }
      if (parsed.params !== undefined) {
        Object.assign(req.params, parsed.params);
      }

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors = error.issues.map((err: z.ZodIssue) => ({
          // Drop the leading "body"/"query"/"params" segment: it is an artefact
          // of how the schema is composed, not something a client can act on.
          field: err.path.slice(1).join(".") || err.path.join("."),
          message: err.message,
        }));
        return res.status(400).json({
          success: false,
          message: "Validation error",
          errors: fieldErrors,
        });
      }
      next(error);
    }
  };
};

// ========================
// Pool Validation Schemas
// ========================

export const createPoolSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Pool name is required").max(100).trim(),
    description: z.string().max(500).optional(),
    rules: z.string().max(1000).optional(),
  }),
});

export const updatePoolSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(500).optional(),
    rules: z.string().max(1000).optional(),
    image: z.string().url("Invalid image URL").optional(),
  }),
});

export const addPoolTxSchema = z.object({
  body: z.object({
    poolId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid poolId"),
    amount: z.number().positive("Amount must be > 0"),
    type: z.enum(["credit", "debit"]),
    date: z.string().datetime("ISO 8601 required"),
    remarks: z.string().optional(),
  }),
});

export const poolMemberSchema = z.object({
  body: z.object({
    userId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid userId"),
  }),
});

// ========================
// Friend Validation Schemas
// ========================

/**
 * Phone search.
 *
 * The route previously had no schema at all and the handler did
 * `const { phone } = req.body; User.findOne({ phone })`. Because
 * `express.json()` happily parses `{"phone": {"$ne": null}}` into an object,
 * that expression became an operator query — returning an arbitrary user, and
 * with `$regex` allowing the whole user table to be walked. Constraining the
 * type to `string` here is what closes it: an object can no longer reach the
 * query builder.
 */
export const searchPhoneSchema = z.object({
  body: z.object({
    phone: z
      .string()
      .trim()
      .min(4, "Enter at least 4 digits")
      .max(20, "Phone number too long"),
  }),
});

export const friendRequestSchema = z.object({
  body: z.object({ toUserId: objectId }),
});

export const friendRequestActionSchema = z.object({
  body: z.object({ requestId: objectId }),
});

export const friendIdParamSchema = z.object({
  params: z.object({ friendId: objectId }),
});

// ========================
// Expense Validation Schemas
// ========================

export const addExpenseSchema = z.object({
  body: z.object({
    amount: money,
    date: isoDate,
    remarks: shortText(200, "Remarks").optional(),
    category: shortText(50, "Category").optional(),
    type: z.enum(["debit", "credit"]).default("debit"),
  }),
});

export const editExpenseSchema = z.object({
  params: z.object({ id: objectId }),
  body: z.object({
    amount: money.optional(),
    date: isoDate.optional(),
    remarks: shortText(200, "Remarks").optional(),
    category: shortText(50, "Category").optional(),
    type: z.enum(["debit", "credit"]).optional(),
  }),
});

export const expenseIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const getExpensesSchema = z.object({
  query: z.object({
    ledgerId: objectId.optional(),
    cursor: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

/**
 * Closing a ledger. `z.coerce.number()` is the fix for a bug that could
 * permanently lock a user out of their current month: the handler guarded with
 * `year === currentYear`, which is false when the client sends the string
 * "2026", so the "past months only" check passed and the *current* ledger was
 * closed — with no reopen endpoint in existence.
 */
export const closeLedgerSchema = z.object({
  body: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
  }),
});

export const checkDuplicateSchema = z.object({
  query: z.object({
    amount: money,
    date: isoDate,
  }),
});

export const expenseStatsSchema = z.object({
  query: z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    period: z.enum(["daily", "monthly", "yearly", "all"]).optional(),
  }),
});

export const exportLedgerSchema = z.object({
  query: z.object({ ledgerId: objectId }),
});

// ========================
// Stats Validation Schemas
// ========================

export const chatStatsSchema = z.object({
  params: z.object({ chatId: objectId }),
  query: z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  }),
});

export const chatIdParamSchema = z.object({
  params: z.object({ chatId: objectId }),
});

export const chatExportSchema = z.object({
  params: z.object({ chatId: objectId }),
  query: z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
  }),
});

// ========================
// Pool Validation Schemas (additions)
// ========================

export const poolIdParamSchema = z.object({
  params: z.object({ poolId: objectId }),
});

export const getPoolTxnsSchema = z.object({
  params: z.object({ poolId: objectId }),
  query: paginationQuery,
});

export const editPoolTxSchema = z.object({
  params: z.object({ txnId: objectId }),
  body: z.object({
    amount: money.optional(),
    type: z.enum(["credit", "debit"]).optional(),
    date: isoDate.optional(),
    remarks: shortText(200, "Remarks").optional(),
  }),
});

export const poolTxIdParamSchema = z.object({
  params: z.object({ txnId: objectId }),
});

export const verifyPoolTxSchema = z.object({
  body: z.object({ txnId: objectId }),
});

// ========================
// Admin Validation Schemas
// ========================

export const adminLoginSchema = z.object({
  body: z.object({
    secretKey: z.string().min(1, "Secret key is required").max(512),
  }),
});

export const adminUserQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(64).optional(),
    sort: z.enum(["-createdAt", "createdAt", "name", "-name", "-_id"]).default("-createdAt"),
  }),
});

export const adminIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const adminExpenseQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    userId: objectId.optional(),
  }),
});

export const adminPoolQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

export const bulkNotificationSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1, "Title is required").max(100),
    body: shortText(500, "Message").default(""),
  }),
});

export const targetedNotificationSchema = z.object({
  body: z.object({
    userIds: z
      .array(objectId)
      .min(1, "Select at least one user")
      .max(1000, "Too many recipients in one request"),
    title: z.string().trim().min(1, "Title is required").max(100),
    body: shortText(500, "Message").default(""),
  }),
});

// ========================
// Notification feed
// ========================

export const notificationQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(120).optional(),
  }),
});

export const notificationIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

//======= App release =======//

const semverString = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, "Version must look like 1.2.3");

export const appReleaseSchema = z.object({
  body: z
    .object({
      latestVersion: semverString,
      minSupportedVersion: semverString,
      apkUrl: z
        .string()
        .trim()
        .url("Must be a valid URL")
        .refine((u) => u.startsWith("https://"), "APK URL must use https"),
      releaseNotes: shortText(1000, "Release notes").default(""),
    })
    .refine(
      (b) => compareVersions(b.minSupportedVersion, b.latestVersion) <= 0,
      {
        message: "Minimum version cannot exceed latest version",
        path: ["minSupportedVersion"],
      },
    ),
});
