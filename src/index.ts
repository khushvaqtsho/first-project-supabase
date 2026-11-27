import { signInAsGuest } from "./auth.js";

const user = await signInAsGuest();
console.log("Signed in guest:", user.id);
console.log("Email:", user.email || "(none — anonymous guest users have no email)");
console.log("is_anonymous:", user.is_anonymous);
