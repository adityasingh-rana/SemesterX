const API_BASE_URL = "/api";

const apiRequest = async (endpoint, options = {}) => {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || "API request failed.");
    }

    return result;

  } catch (error) {
    console.error("API Error:", error.message);
    throw error;
  }
};

const SemesterXAPI = {
  // Retrieve application state
  getState: async () => {
    return apiRequest("/state");
  },

  // Save application state
  saveState: async (data) => {
    return apiRequest("/state", {
      method: "PUT",
      body: JSON.stringify({ data })
    });
  }
};

window.SemesterXAPI = SemesterXAPI;