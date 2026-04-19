import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SignInForm } from './sign-in-form';

export default function SignInPage() {
  return (
    <main className="flex items-center justify-center py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Email magic link or Google. No password to remember.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
    </main>
  );
}
