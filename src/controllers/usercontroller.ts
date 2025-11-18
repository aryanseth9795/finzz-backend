import TryCatch from "../utils/TryCatch.js";
import { User } from "../models/userModel.js";
import { Request, Response, NextFunction } from "express";
import Errorhandler from "../middlewares/Errorhandler.js";
import sendToken from "../utils/sendtoken.js";

export const login = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { Phone, password } = req.body;

    const user = await User.findOne({ phone: Phone });
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    const isPasswordMatched = await user.comparePassword(password);
    if (!isPasswordMatched) {
      return next(new Errorhandler("Invalid Credentials", 401));
    }

    sendToken(res, user, 200);
  }
);



export const register = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, phone, password,      email } = req.body;
    const existingUser = await User.findOne({ phone: phone });
    if (existingUser) {
      return next(new Errorhandler("User already exists", 400));
    }
    const user = await User.create({
      name,
      phone,
      password,
      email
    });
    sendToken(res, user, 201);
  }
);


export const logout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    res.cookie("access_token", null, {
      expires: new Date(Date.now()),
      httpOnly: true,
    }); 
});


export const getUserProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    res.status(200).json({
      success: true,
      user,
    });
  }
);

export const sendInvite = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone } = req.body;

    const userexists = await User.findOne({ phone: phone });
    if (!userexists) {
      return next(new Errorhandler("User does not exist with this phone number", 400));
    }

    res.status(200).json({
      success: true,
      message: `Invite sent to ${phone}`,
    });
  }
);