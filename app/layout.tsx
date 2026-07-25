import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Press_Start_2P, VT323 } from 'next/font/google'
import './globals.css'

const pressStart = Press_Start_2P({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-pixel',
})

const vt323 = VT323({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-vt',
})

export const metadata: Metadata = {
  title: 'Árbol de Logros · Ing. Civil en Informática y Telecomunicaciones',
  description:
    'Explora la malla de Ingeniería Civil en Informática y Telecomunicaciones como un árbol de logros al estilo Minecraft.',
  generator: 'v0.app',
  icons: {
    icon: '/minecraft.svg',
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#1b1b1b',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="es" className={`${pressStart.variable} ${vt323.variable} bg-[#1b1b1b]`}>
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}