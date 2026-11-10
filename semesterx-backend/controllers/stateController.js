const AppState = require("../models/AppState");

// GET: Retrieve SemesterX application data
exports.getState = async (req, res) => {
  try {
    const state = await AppState.findById("primary").lean();

    if (!state) {
      return res.status(200).json({
        success: true,
        exists: false,
        data: null
      });
    }

    return res.status(200).json({
      success: true,
      exists: true,
      data: state.data,
      updatedAt: state.updatedAt
    });

  } catch (error) {
    console.error("Get State Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve application data."
    });
  }
};


// PUT: Save SemesterX application data
exports.saveState = async (req, res) => {
  try {
    const { data } = req.body;

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        message: "Valid application data is required."
      });
    }

    if (!Array.isArray(data.subjects)) {
      return res.status(400).json({
        success: false,
        message: "Invalid application state: subjects must be an array."
      });
    }

    const state = await AppState.findByIdAndUpdate(
      "primary",
      {
        $set: {
          data,
          schemaVersion: 1
        }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    return res.status(200).json({
      success: true,
      message: "Application data saved successfully.",
      updatedAt: state.updatedAt
    });

  } catch (error) {
    console.error("Save State Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save application data."
    });
  }
};