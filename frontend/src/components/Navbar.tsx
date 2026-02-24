'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Library, Download, Settings, Sailboat, Play, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';

const navItems = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/library', label: 'Library', icon: Library },
  { href: '/downloads', label: 'Downloads', icon: Download },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default function Navbar() {
  const pathname = usePathname();
  const [jellyfinUrl, setJellyfinUrl] = useState<string | null>(null);

  useEffect(() => {
    // Check Jellyfin status and get URL
    api.getJellyfinStatus().then((status) => {
      if (status.available) {
        setJellyfinUrl('/jellyfin-redirect');
      }
    }).catch(() => {
      // Jellyfin not available
    });
  }, []);

  return (
    <nav className="bg-slate-900 border-b border-slate-800">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <Sailboat className="w-8 h-8 text-primary-500" />
            <span className="text-xl font-bold">Qar</span>
          </Link>

          {/* Navigation Links */}
          <div className="flex items-center gap-1">
            {navItems.map(item => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-primary-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span className="hidden sm:inline">{item.label}</span>
                </Link>
              );
            })}

            {/* Jellyfin Link */}
            {jellyfinUrl && (
              <Link
                href={jellyfinUrl}
                className="flex items-center gap-2 px-4 py-2 rounded-lg transition-colors bg-purple-600 hover:bg-purple-700 text-white ml-2"
              >
                <Play className="w-5 h-5" />
                <span className="hidden sm:inline">Watch</span>
                <ExternalLink className="w-4 h-4 hidden sm:inline" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
