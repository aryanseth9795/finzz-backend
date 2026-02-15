# Cloudinary Image Upload - API Documentation

## Overview

The Finzz backend now supports profile image uploads via **Cloudinary** with automatic image optimization.

---

## 🔧 Setup

### 1. Get Cloudinary Credentials

1. Create account at [cloudinary.com](https://cloudinary.com)
2. Go to **Dashboard** → copy:
   - `Cloud Name`
   - `API Key`
   - `API Secret`

### 2. Configure Environment Variables

Add to your `.env` file:

```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_FOLDER=finzz/avatars
```

> See [.env.example](file:///d:/Desktop/Finxxz/Finzz-Backend/.env.example) for complete template

---

## 📡 API Endpoint

### **POST** `/api/v1/users/upload-avatar`

Upload or update user profile picture.

#### Authentication

- **Required**: Yes (Bearer token)
- **Header**: `Authorization: Bearer <access_token>`

#### Request

**Content-Type**: `multipart/form-data`

| Field    | Type | Required | Description                       |
| -------- | ---- | -------- | --------------------------------- |
| `avatar` | File | Yes      | Image file (JPEG, JPG, PNG, WebP) |

**File Constraints**:

- Max size: **5 MB**
- Allowed types: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`

#### Response

**Success (200)**:

```json
{
  "success": true,
  "message": "Avatar uploaded successfully",
  "avatar": "https://res.cloudinary.com/demo/image/upload/v1234/finzz/avatars/abc123.jpg",
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "name": "John Doe",
    "phone": "+1234567890",
    "avatar": "https://res.cloudinary.com/demo/.../abc123.jpg",
    "friends": []
  }
}
```

**Error (400 - No file)**:

```json
{
  "success": false,
  "message": "No image file provided"
}
```

**Error (400 - Invalid type)**:

```json
{
  "success": false,
  "message": "Invalid file type. Only JPEG, JPG, PNG, and WebP images are allowed."
}
```

**Error (413 - File too large)**:

```json
{
  "success": false,
  "message": "File too large"
}
```

---

## 🎨 Image Transformations

Uploaded images are automatically optimized:

- **Size**: 500x500 pixels
- **Crop**: `fill` with `gravity: face` (centers on face if detected)
- **Quality**: Auto (Cloudinary optimizes for best quality/size balance)
- **Format**: Auto (serves WebP to supported browsers)

---

## 🧪 Testing with cURL

```bash
curl -X POST http://localhost:3000/api/v1/users/upload-avatar \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -F "avatar=@/path/to/image.jpg"
```

---

## 🧪 Testing with Postman

1. **Method**: POST
2. **URL**: `http://localhost:3000/api/v1/users/upload-avatar`
3. **Headers**:
   - `Authorization`: `Bearer <your_access_token>`
4. **Body**:
   - Type: `form-data`
   - Key: `avatar` (File type)
   - Value: Select image file

---

## 🔄 How It Works

1. **Upload**: User sends image via multipart/form-data
2. **Validation**: Multer checks file type and size
3. **Delete Old**: If user has existing avatar, delete from Cloudinary
4. **Upload New**: Upload image buffer to Cloudinary with transformations
5. **Update DB**: Save Cloudinary URL to user's `avatar` field
6. **Response**: Return new avatar URL

---

## 📁 File Structure

```
src/
├── config/
│   └── cloudinary.ts          # Cloudinary configuration
├── services/
│   └── cloudinaryService.ts   # Upload/delete functions
├── middlewares/
│   └── upload.ts               # Multer configuration
├── controllers/
│   └── usercontroller.ts       # uploadAvatar endpoint
└── routes/
    └── userRoutes.ts           # POST /upload-avatar route
```

---

## 🛠️ Code Examples

### Frontend (React Native with Expo)

```typescript
import * as ImagePicker from "expo-image-picker";

async function uploadAvatar() {
  // Pick image
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });

  if (!result.canceled) {
    const formData = new FormData();
    formData.append("avatar", {
      uri: result.assets[0].uri,
      type: "image/jpeg",
      name: "avatar.jpg",
    } as any);

    const response = await fetch(
      "http://localhost:3000/api/v1/users/upload-avatar",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      },
    );

    const data = await response.json();
    console.log("New avatar URL:", data.avatar);
  }
}
```

### Frontend (Web with Axios)

```javascript
async function uploadAvatar(file) {
  const formData = new FormData();
  formData.append("avatar", file);

  const { data } = await axios.post(
    "http://localhost:3000/api/v1/users/upload-avatar",
    formData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "multipart/form-data",
      },
    },
  );

  console.log("New avatar URL:", data.avatar);
}
```

---

## 🔐 Security Features

✅ **File type validation** - Only images allowed  
✅ **File size limit** - Max 5 MB  
✅ **Authentication required** - Bearer token  
✅ **Auto-deletion** - Old avatar removed when uploading new one  
✅ **Secure URLs** - HTTPS delivery via Cloudinary CDN

---

## 🚨 Error Handling

The endpoint handles:

- Missing file
- Invalid file type
- File too large
- Cloudinary upload failures
- Database update failures
- Invalid authentication

All errors return proper HTTP status codes and JSON error messages.

---

## 📝 Notes

- **Old avatar deletion**: Automatically deletes previous avatar from Cloudinary when user uploads new one
- **Storage**: Images stored in Cloudinary folder: `finzz/avatars/`
- **CDN**: Cloudinary serves images via global CDN for fast loading
- **Bandwidth**: Free tier: 25 GB/month, 25,000 transformations/month

---

## 🔗 Related Endpoints

- `GET /api/v1/users/profile` - Get user profile (includes avatar URL)
- `PUT /api/v1/users/profile` - Update profile (can set avatar URL manually if needed)

---

## ✅ Complete!

Your backend now supports Cloudinary image uploads with automatic optimization, face detection cropping, and old image cleanup.
