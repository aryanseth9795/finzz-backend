import mongoose, { Document, Schema } from "mongoose";
import { hash, compare } from "bcrypt";

// TypeScript interface for User document
export interface IUser extends Document {
  name: string;
  phone: string; // PRIMARY LOGIN IDENTIFIER (mobile number)
  password: string;
  avatar?: string;
  friends: mongoose.Types.ObjectId[];
  pushToken?: string;
  refreshToken?: string;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true, // For fast searches by phone
  },
  password: {
    type: String,
    required: true,
  },
  avatar: {
    type: String,
    default: "",
  },
  friends: [
    {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  pushToken: {
    type: String,
  },
  refreshToken: {
    type: String,
  },
});

userSchema.pre("save", async function (next) {
  const user = this;
  if (!user.isModified("password")) return next();

  this.password = await hash(this.password, 10);
  next();
});

// Instance method for password comparison
userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  return compare(candidatePassword, this.password);
};

export const User =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);
