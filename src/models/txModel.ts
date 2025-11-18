// import mongoose from "mongoose";

// const txSchema = new mongoose.Schema({
//   amount: {
//     type: Number,   
//     required: true,
//   },
//   date: {
//     type: Date,
//     required: true,
//   },
//   remarks: {
//     type: String,
//   },
//   to:{
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true,
//   },
//     from:{
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true,
//   },
//     addedBy:{
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true,
//   },
//   verified: {
//     type: Boolean,
//     default: false,
//   },
// });

// export const Tx = mongoose.models.Tx || mongoose.model("Tx", txSchema);


import mongoose from "mongoose";

const txSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      required: true,
      index: true, // single-field index for range queries
    },
    remarks: {
      type: String,
      trim: true,
    },
    to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    from: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    verified: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,     // createdAt / updatedAt
    versionKey: false,    // remove __v
  }
);

// compound indexes for common queries
txSchema.index({ from: 1, date: -1 });
txSchema.index({ to: 1, date: -1 });
txSchema.index({ addedBy: 1, date: -1 });
txSchema.index({ from: 1, to: 1, date: -1 });

export const Tx = mongoose.models.Tx || mongoose.model("Tx", txSchema);
