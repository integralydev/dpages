import type { Metadata } from 'next';
import { Libre_Baskerville, Montserrat } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';
import { AuthGuard } from '@/components/auth/AuthGuard';
import { AuthProvider } from '@/hooks/useAuth';
import { NavigationGuardProvider } from '@/hooks/useNavigationGuard';

// Mateixes tipografies que dpages.cat: Montserrat per a la interfície i
// Libre Baskerville cursiva per als títols.
const montserrat = Montserrat({
  variable: '--font-montserrat',
  subsets: ['latin'],
});

const libreBaskerville = Libre_Baskerville({
  variable: '--font-libre-baskerville',
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
});

export const metadata: Metadata = {
  title: 'Gestió de Comandes - dPagès',
  description: 'Panell operatiu de gestió de comandes de dPagès',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="ca"
      className={`${montserrat.variable} ${libreBaskerville.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <AuthProvider>
          <AuthGuard>
            <NavigationGuardProvider>
              <AppShell>{children}</AppShell>
            </NavigationGuardProvider>
          </AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
