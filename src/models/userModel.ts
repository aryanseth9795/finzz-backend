import mongoose from "mongoose";
import { hash } from "bcrypt";

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
    unique: true,
  },
});

userSchema.pre("save", async function (next) {
  const user = this;
  if (!user.isModified("password")) return next();

  this.password = await hash(this.password, 10);

  // Hash password logic here (e.g., using bcrypt)
  // next();
});

export const User = mongoose.models.User || mongoose.model("User", userSchema);
