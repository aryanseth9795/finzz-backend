import mongoose, { Document, Schema } from "mongoose";
import { hash, compare } from "bcrypt";

// TypeScript interface for User document
export interface IUser extends Document {
  name: string;
  phone: string; // PRIMARY LOGIN IDENTIFIER (mobile number)
  password: string;
  email?: string;
  emailVerified: boolean;
  otp?: string; // bcrypt-hashed OTP
  otpExpiry?: Date;
  avatar?: string;
  friends: mongoose.Types.ObjectId[];
  pushToken?: string;
  refreshToken?: string;
  comparePassword(candidatePassword: string): Promise<boolean>;
  compareOtp(candidateOtp: string): Promise<boolean>;
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
  email: {
    type: String,
    unique: true,
    sparse: true, // allows multiple null values
    lowercase: true,
    trim: true,
  },
  emailVerified: {
    type: Boolean,
    default: false,
  },
  otp: {
    type: String, // stored as bcrypt hash
  },
  otpExpiry: {
    type: Date,
  },
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

// Instance method for OTP comparison
userSchema.methods.compareOtp = async function (
  candidateOtp: string,
): Promise<boolean> {
  if (!this.otp) return false;
  return compare(candidateOtp, this.otp);
};

export const User =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);
