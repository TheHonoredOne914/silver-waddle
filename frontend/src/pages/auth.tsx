import React from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FcGoogle } from "react-icons/fc";

export default function AuthPage() {
  const handleGoogleSignIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/`,
      },
    });
    if (error) {
      console.error("Error logging in with Google:", error.message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Welcome back
          </CardTitle>
          <CardDescription>
            Sign in to your account to continue
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="w-full relative py-6"
            onClick={handleGoogleSignIn}
          >
            <FcGoogle className="absolute left-4 w-5 h-5" />
            <span className="text-sm font-medium">Continue with Google</span>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
