# Mobile App Authentication Guide (Expo)

## Overview

The Finzz backend is now configured for **mobile-only authentication** with header-based tokens (no cookies, no CORS).

---

## 🔐 Authentication Flow

### 1. **Login/Register**

**Endpoint**: `POST /api/v1/users/login` or `POST /api/v1/users/register`

**Request**:

```json
{
  "phone": "+1234567890",
  "password": "yourpassword"
}
```

**Response**:

```json
{
  "success": true,
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "507f1f77bcf86cd799439011",
    "name": "John Doe",
    "phone": "+1234567890",
    "avatar": "https://..."
  }
}
```

### 2. **Store Tokens (React Native)**

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage";
// Or use expo-secure-store for better security

async function handleLogin(phone: string, password: string) {
  const response = await fetch("http://localhost:3000/api/v1/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });

  const data = await response.json();

  if (data.success) {
    // Store tokens
    await AsyncStorage.setItem("access_token", data.access_token);
    await AsyncStorage.setItem("refresh_token", data.refresh_token);
    await AsyncStorage.setItem("user", JSON.stringify(data.user));
  }
}
```

### 3. **Authenticated Requests**

```typescript
async function makeAuthenticatedRequest(
  url: string,
  options: RequestInit = {},
) {
  const accessToken = await AsyncStorage.getItem("access_token");

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  return response.json();
}

// Example usage
const profile = await makeAuthenticatedRequest(
  "http://localhost:3000/api/v1/users/profile",
);
```

### 4. **Refresh Token When Access Token Expires**

**Method 1: Using Authorization Header (Recommended)**

```typescript
async function refreshAccessToken() {
  const refreshToken = await AsyncStorage.getItem("refresh_token");

  const response = await fetch("http://localhost:3000/api/v1/users/refresh", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  if (data.success) {
    // Update stored tokens
    await AsyncStorage.setItem("access_token", data.access_token);
    await AsyncStorage.setItem("refresh_token", data.refresh_token);
    return data.access_token;
  }

  throw new Error("Failed to refresh token");
}
```

**Method 2: Using Request Body**

```typescript
async function refreshAccessToken() {
  const refreshToken = await AsyncStorage.getItem("refresh_token");

  const response = await fetch("http://localhost:3000/api/v1/users/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  const data = await response.json();

  if (data.success) {
    await AsyncStorage.setItem("access_token", data.access_token);
    await AsyncStorage.setItem("refresh_token", data.refresh_token);
    return data.access_token;
  }

  throw new Error("Failed to refresh token");
}
```

### 5. **Auto-Refresh on 401 Error**

```typescript
async function fetchWithAutoRefresh(url: string, options: RequestInit = {}) {
  const accessToken = await AsyncStorage.getItem("access_token");

  let response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  // If 401, try refreshing token
  if (response.status === 401) {
    const newAccessToken = await refreshAccessToken();

    // Retry request with new token
    response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${newAccessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  return response.json();
}
```

### 6. **Logout**

```typescript
async function handleLogout() {
  const accessToken = await AsyncStorage.getItem("access_token");

  // Call logout endpoint (nullifies refresh token in DB)
  await fetch("http://localhost:3000/api/v1/users/logout", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  // Clear local storage
  await AsyncStorage.multiRemove(["access_token", "refresh_token", "user"]);
}
```

---

## 📱 Complete React Native Example (Context API)

```typescript
// auth/AuthContext.tsx
import React, { createContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type User = {
  _id: string;
  name: string;
  phone: string;
  avatar?: string;
};

type AuthContextType = {
  user: User | null;
  login: (phone: string, password: string) => Promise<void>;
  register: (name: string, phone: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoading: boolean;
};

export const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider: React.FC = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadUser();
  }, []);

  async function loadUser() {
    try {
      const userJson = await AsyncStorage.getItem('user');
      if (userJson) {
        setUser(JSON.parse(userJson));
      }
    } catch (error) {
      console.error('Failed to load user', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function login(phone: string, password: string) {
    const response = await fetch('http://localhost:3000/api/v1/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password }),
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.message || 'Login failed');
    }

    await AsyncStorage.setItem('access_token', data.access_token);
    await AsyncStorage.setItem('refresh_token', data.refresh_token);
    await AsyncStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  }

  async function register(name: string, phone: string, password: string) {
    const response = await fetch('http://localhost:3000/api/v1/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, password }),
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.message || 'Registration failed');
    }

    await AsyncStorage.setItem('access_token', data.access_token);
    await AsyncStorage.setItem('refresh_token', data.refresh_token);
    await AsyncStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  }

  async function logout() {
    const accessToken = await AsyncStorage.getItem('access_token');

    await fetch('http://localhost:3000/api/v1/users/logout', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user']);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

// useAuth hook
export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
```

---

## 🔑 Token Lifetimes

- **Access Token**: 2 days (short-lived for security)
- **Refresh Token**: 30 days (long-lived, stored in DB)

---

## 📋 Summary

✅ No cookies — tokens in JSON response  
✅ No CORS — mobile app only  
✅ Authorization header — `Bearer <token>`  
✅ Auto-refresh — on 401 errors  
✅ Secure storage — AsyncStorage or SecureStore

Your backend is now fully optimized for mobile (Expo) authentication!
