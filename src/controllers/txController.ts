import { NextFunction, Request, Response } from "express";
import TryCatch from "../utils/TryCatch.js";
import { Tx } from "../models/txModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import mongoose from "mongoose";


export const addtxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { to, from, amount, date, remark, addedby } = req.body;

    const txns = await Tx.create({
      to,
      from,
      amount,
      date,
      remark,
      addedby,
    });

    res.status(201).json({
      success: true,
      message: "Transaction Created Successfully",
    });
  }
);

export const getTxns = TryCatch(
  async (
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction
  ) => {
    const { othermemberId } = req.body;

    if (!othermemberId) {
      return res.status(400).json({
        success: false,
        message: "othermemberId is required",
      });
    }

    const userId = req.user?.id;

    const txns = await Tx.find({
      $or: [
        { from: userId, to: othermemberId },
        { from: othermemberId, to: userId },
      ],
    })
      .sort({ date: -1, _id: -1 }) // latest first
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,
      count: txns.length,
      txns,
    });
  }
);

export const verifyTxn = TryCatch(
  async (
    req: Request & { user?: { id: string } },
    res: Response,
    next: NextFunction
  ) => {
    const { txnId } = req.body;

    const gettxbyId = await Tx.findById(txnId);

    if (!gettxbyId) {
      return next(new ErrorHandler("Transaction Not found", 404));
    }

    const userId = req.user?.id;
    if (gettxbyId.addedBy === userId) {
      return next(new ErrorHandler("YOU CAN NOT VERIFY THIS TXNS", 401));
    }

    gettxbyId.verified = true;
    await gettxbyId.save();

    res.status(200).json({
      success: true,
      message: "Transaction verified successfully",
    });
  }
);

export const getAllTxnsUser = TryCatch(
  async (req: Request & { user?: { id?: string } }, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const userObjectId = new  (require('mongoose').Types.ObjectId)(userId);
  

    const friends = await Tx.aggregate([
      {
        $match: {
          $or: [{ from: userObjectId }, { to: userObjectId }],
        },
      },
      {
        $addFields: {
          otherUser: {
            $cond: [
              { $eq: ["$from", userObjectId] },
              "$to",
              "$from",
            ],
          },
        },
      },
      {
        $group: {
          _id: "$otherUser",        // this is friendId
          latestDate: { $max: "$date" },
        },
      },
      { $sort: { latestDate: -1 } },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 0,
          friendId: "$_id",        // 👈 friend userId
          name: "$user.name",
          date: "$latestDate",
        },
      },
      { $limit: 50 }, 
    ]);

    return res.status(200).json({
      success: true,
      friends, // [{ friendId, name, date }]
    });
  }
);