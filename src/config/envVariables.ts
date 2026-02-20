import dotenv from "dotenv";


dotenv.config({path: "./.env"});
console.log(process.env.MONGO_URL);


const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";
const JWT_EXPIRES_IN: string | number | undefined =
  process.env.JWT_EXPIRES_IN || "7d";
const COOKIE_EXPIRES_IN = process.env.COOKIE_EXPIRES_IN
  ? parseInt(process.env.COOKIE_EXPIRES_IN)
  : 7; // Default to 7 days
const adminSecretKey = process.env.ADMIN_SECRET_KEY! ;

const MongoURL = process.env.MONGO_URL! || "mongodb://localhost:27017/finzz";

export { JWT_SECRET, JWT_EXPIRES_IN, COOKIE_EXPIRES_IN, adminSecretKey, MongoURL };