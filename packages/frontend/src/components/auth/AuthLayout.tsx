import Image from 'next/image';
import type { ReactNode } from 'react';

// Marc comú de les pantalles sense sessió (login, restabliment de
// contrasenya), amb la identitat de dpages.cat: panell grafit amb el
// logotip i el lema en Libre Baskerville cursiva, i el formulari a la
// dreta. En mòbil el panell queda com a capçalera i la targeta hi puja per
// sobre.
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      <div className="flex shrink-0 flex-col gap-4 bg-graphite px-7 pt-12 pb-16 lg:w-[44%] lg:justify-between lg:px-16 lg:py-16">
        <Image
          src="/brand/dpages-logotip.png"
          alt="dpagès"
          width={313}
          height={112}
          priority
          className="h-12 w-auto self-start lg:h-[72px]"
        />
        <div className="flex flex-col gap-5">
          <div className="hidden h-[3px] w-12 rounded-sm bg-brand lg:block" />
          <p className="font-display text-xl leading-snug text-white italic lg:text-4xl lg:leading-tight">
            <span className="lg:hidden">Gestió de comandes</span>
            <span className="hidden lg:inline">
              Carn i embotits de porc ecològic, de la granja a la taula.
            </span>
          </p>
          <p className="hidden max-w-md text-[15px] leading-relaxed text-gray-200 lg:block">
            Panell intern de gestió de comandes per a oficina, obrador, empaquetat i producció.
          </p>
        </div>
        <p className="hidden text-xs text-gray-300 lg:block">dpagès · Gestió de comandes</p>
      </div>

      <div className="flex flex-1 items-start justify-center px-4 lg:items-center">
        <div className="-mt-10 mb-10 w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm lg:my-0">
          <h1 className="font-display text-2xl text-gray-900 italic">{title}</h1>
          {subtitle && <div className="mt-1 text-sm text-gray-500">{subtitle}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}
