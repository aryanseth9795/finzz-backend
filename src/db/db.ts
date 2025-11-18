import mongoose from "mongoose";

const connectDb = async (url:string) => {
  try {
    await mongoose.connect(url);
    console.log("Database connected successfully");
  } catch (error) {
    console.error("Database connection failed", error);
  }
};

export default connectDb;