import { Server } from 'socket.io'
import app from '@adonisjs/core/services/app'
import server from '@adonisjs/core/services/server'

let io: Server

let isLive = false
let broadcasterId: string | null = null
let viewers = new Set<string>()

app.ready(() => {
    io = new Server(server.getNodeServer(), {
        cors: { origin: '*' },
    })

    io.on('connection', (socket) => {
        console.log('User connected:', socket.id)

        socket.on('start-live', () => {
            if (!isLive) {
                isLive = true
                broadcasterId = socket.id
                console.log('Live started by:', socket.id)

                io.emit('live-started')
            }
        })

        socket.on('join-live', () => {
            if (isLive && socket.id !== broadcasterId) {
                viewers.add(socket.id)

                io.emit('viewer-count', viewers.size)
            }
        })

        socket.on('stop-live', () => {
            if (socket.id === broadcasterId) {
                isLive = false
                broadcasterId = null
                viewers.clear()

                io.emit('live-stopped')
                io.emit('viewer-count', 0)

                console.log('Live stopped')
            }
        })

        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id)

            if (socket.id === broadcasterId) {
                isLive = false
                broadcasterId = null
                viewers.clear()

                io.emit('live-stopped')
                io.emit('viewer-count', 0)
            } else {
                viewers.delete(socket.id)
                io.emit('viewer-count', viewers.size)
            }
        })
        socket.on('viewer-joined', () => {
            if (broadcasterId) {
                io.to(broadcasterId).emit('new-viewer', socket.id)
            }
        })

        socket.on('offer', ({ target, offer }) => {
            io.to(target).emit('offer', {
                from: socket.id,
                offer,
            })
        })

        socket.on('answer', ({ target, answer }) => {
            io.to(target).emit('answer', {
                from: socket.id,
                answer,
            })
        })

        socket.on('ice-candidate', ({ target, candidate }) => {
            io.to(target).emit('ice-candidate', {
                from: socket.id,
                candidate,
            })
        })

    })
})

export { io }
