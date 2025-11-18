import express from "express";

import cookieParser from "cookie-parser";
import userRoutes from "./src/routes/userRoutes.js";
import txRoutes from "./src/routes/txnRoutes.js";
import errorMiddleware from "./src/middlewares/error.js";
import dotenv from "dotenv";
import connectDb from "./src/db/db.js";
import { MongoURL } from "./src/config/envVariables.js";

dotenv.config();

connectDb(MongoURL);
const app = express();
app.use(express.json());

app.use(cookieParser());

app.use(express.urlencoded({ extended: true }));
app.get("/health", (req, res) => {
  res.send("Welcome to the Finzz Backend API");
});
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/txns", txRoutes);
app.use(errorMiddleware);

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

export default app;
