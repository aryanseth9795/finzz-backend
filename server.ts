import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
// Routes
import userRoutes from "./src/routes/userRoutes.js";
import txRoutes from "./src/routes/txnRoutes.js";
import friendRoutes from "./src/routes/friendRoutes.js";
import chatRoutes from "./src/routes/chatRoutes.js";
import statsRoutes from "./src/routes/statsRoutes.js";
import poolRoutes from "./src/routes/poolRoutes.js";
import expenseRoutes from "./src/routes/expenseRoutes.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import { MongoURL } from "./src/config/envVariables.js";

// Middleware
import errorMiddleware from "./src/middlewares/error.js";

// DB
import connectDb from "./src/db/db.js";



// Connect to MongoDB

connectDb(MongoURL);

const app = express();

// Middleware
app.use(
  cors({
    origin: ["https://finzzadmin.netlify.app/", "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => {
  res.send("Welcome to the Finzz Backend API");
});

// API Routes
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/txns", txRoutes);
app.use("/api/v1/friends", friendRoutes); // Friend system with contact sync
app.use("/api/v1/chats", chatRoutes); // WhatsApp-style chat list
app.use("/api/v1/stats", statsRoutes); // Transaction statistics
app.use("/api/v1/pools", poolRoutes); // Pool management
app.use("/api/v1/expenses", expenseRoutes); // Daily expense tracker
app.use("/api/v1/admin", adminRoutes); // Admin panel

// Error handling middleware (must be last)
app.use(errorMiddleware);

function ping() {
  axios.get(process.env.API_URL + "/health").then((res) => {
    console.log(res.data);
  });
}

setInterval(ping, 720000);

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

export default app;
