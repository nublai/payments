import { defineConfig } from 'vocs/config'

export default defineConfig({
    title: 'Payments',
    description:
        'Smart accounts, a relayer, and a local wallet CLI for agent-initiated payments.',
    srcDir: '.',
    pagesDir: 'pages',
    outDir: 'dist',
    renderStrategy: 'full-static',
    sidebar: [
        { text: 'Introduction', link: '/' },
        { text: 'Install and quickstart', link: '/install' },
        { text: 'MCP', link: '/mcp' },
        { text: 'Security model', link: '/security' },
        { text: 'Relayer', link: '/relayer' },
        { text: 'Signing', link: '/signing' },
        { text: 'Contracts', link: '/contracts' },
        { text: 'Local development', link: '/local-development' },
        { text: 'Deployment', link: '/deployment' },
    ],
})
