// import { Response } from 'express';
// import jwt from 'jsonwebtoken';
// import { COOKIE_EXPIRES_IN, JWT_EXPIRES_IN, JWT_SECRET } from '../config/envVariables';
// const sendToken = (res: Response, user: any, statusCode: number) => {
//     const token = jwt.sign({ id: user._id },JWT_SECRET , {
//         expiresIn: JWT_EXPIRES_IN ,
//         // expiresIn:"5"
//     }); 
//     const options = {
//         expires: new Date(
//             Date.now() + COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
//         ),
//         httpOnly: true,
//     };  
//     res.status(statusCode).cookie('access_token', token, options).json({
//         success: true,
//         access_token: token,
//         user,
//     });
// };

// export default sendToken;


import { Response } from "express";
import jwt, { Secret } from "jsonwebtoken";
import { COOKIE_EXPIRES_IN, JWT_EXPIRES_IN, JWT_SECRET } from "../config/envVariables.js";

type JWT_EXPIRES_IN =  number | undefined;

const sendToken = (res: Response, user: any, statusCode: number) => {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined");

  const token = jwt.sign(
    { id: user._id },
    JWT_SECRET as Secret,
    {
      expiresIn: JWT_EXPIRES_IN as JWT_EXPIRES_IN, // e.g. "1d" / "15m" / 3600
    }
  );
  const options = {
    expires: new Date(
      Date.now() + COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000 // COOKIE_EXPIRES_IN is number now
    ),
    httpOnly: true,
  };

  res
    .status(statusCode)
    .cookie("access_token", token, options)
    .json({
      success: true,
      access_token: token,
      user,
    });
};

export default sendToken;
