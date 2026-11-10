const mongoose = require("mongoose");

const appStateSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "primary"
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },

    schemaVersion: {
      type: Number,
      default: 1
    }
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "app_state"
  }
);

module.exports = mongoose.model("AppState", appStateSchema);