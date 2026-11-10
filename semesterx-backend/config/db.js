const mongoose = require("mongoose");

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = {
    conn: null,
    promise: null
  };
}

const connectDB = async () => {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const options = {
      dbName: process.env.DB_NAME
    };

    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, options)
      .then((mongoose) => {
        console.log("MongoDB Connected Successfully!");
        console.log("Database:", mongoose.connection.name);
        return mongoose;
      })
      .catch((error) => {
        cached.promise = null;
        throw error;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
};

module.exports = connectDB;