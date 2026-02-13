import type { HttpContext } from '@adonisjs/core/http'
import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import app from '@adonisjs/core/services/app'

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic)
}

export default class VideoController {
    async uploadVideo({ request, response }: HttpContext) {
        try {
            console.log('🎬 Starting video upload...')

            const videoFile = request.file('video')
            if (!videoFile) {
                return response.status(400).json({ success: false, message: 'No video file provided' })
            }

            const customThumbnailFile = request.file('thumbnail')

            // 1. Save video
            const uploadDir = app.publicPath('uploads/videos')
            await fs.mkdir(uploadDir, { recursive: true })
            const fileName = `${Date.now()}-${uuid()}.mp4`
            await videoFile.move(uploadDir, { name: fileName })
            const videoPath = path.join(uploadDir, fileName)
            const videoUrl = `/uploads/videos/${fileName}`
            console.log(`✅ Video saved: ${videoPath}`)

            // 2. Duration
            const duration = await this.getVideoDuration(videoPath)
            console.log(`📹 Duration: ${duration}s (${this.formatTime(duration)})`)
            if (duration <= 0) throw new Error('Invalid video duration')

            // 3. Calculate frames
            const { frameCount, interval } = this.calculateFrameCount(duration)
            console.log(`🎯 Frame Count: ${frameCount} (every ${interval.toFixed(2)}s)`)

            // 4. Create video folder
            const videoFolderId = uuid()
            const thumbnailDir = app.publicPath(`thumbnails/${videoFolderId}`)
            await fs.mkdir(thumbnailDir, { recursive: true })

            // 5. 🔥 OPTIMIZED: Generate sprite directly using ffmpeg (much faster!)
            console.log('🚀 Generating sprite with ffmpeg...')
            const spriteInfo = await this.generateSpriteOptimized(
                videoPath,
                thumbnailDir,
                videoFolderId,
                frameCount,
                interval,
                duration
            )
            console.log(`✅ Sprite generated: ${spriteInfo.columns}x${spriteInfo.rows}`)

            // 6. Handle custom thumbnail (for video poster)
            let posterPath = ''
            if (customThumbnailFile) {
                const posterName = `poster.webp`
                const posterFilePath = path.join(thumbnailDir, posterName)
                await customThumbnailFile.move(thumbnailDir, { name: posterName })
                posterPath = `/thumbnails/${videoFolderId}/${posterName}`
                console.log('✅ Custom poster saved')
            }

            // 7. Generate thumbnail metadata for frontend
            const thumbnails: any[] = []
            for (let i = 0; i < frameCount; i++) {
                const timeSecond = Number((i * interval).toFixed(2))
                thumbnails.push({
                    frameNo: i + 1,
                    timeSecond,
                    timeLabel: this.formatTime(timeSecond),
                })
            }

            return response.json({
                success: true,
                message: 'Video processed successfully',
                data: {
                    videoId: videoFolderId,
                    fileName: videoFile.clientName,
                    videoUrl,
                    posterUrl: posterPath,  // 🔥 For video poster
                    duration,
                    durationFormatted: this.formatTime(duration),
                    thumbnailCount: frameCount,
                    interval,
                    intervalLabel: interval === 1 ? '1 per second' : `every ${interval.toFixed(2)}s`,
                    sprite: spriteInfo,
                    thumbnails,  // Just metadata, no image paths
                },
            })
        } catch (error: any) {
            console.error('❌ Error:', error)
            return response.status(500).json({ success: false, message: error.message })
        }
    }

    // 🔥 OPTIMIZED: Generate sprite directly with ffmpeg (10x faster!)
    private generateSpriteOptimized(
        videoPath: string,
        outputDir: string,
        videoId: string,
        frameCount: number,
        interval: number,
        duration: number
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            const thumbWidth = 160
            const thumbHeight = 90
            const columns = 5
            const rows = Math.ceil(frameCount / columns)
            const spritePath = path.join(outputDir, 'sprite.jpg')

            // Calculate fps for extraction
            const fps = 1 / interval  // e.g., interval=2 => fps=0.5 (1 frame every 2 sec)

            // 🚀 Single ffmpeg command to create sprite
            ffmpeg(videoPath)
                .outputOptions([
                    `-vf fps=${fps},scale=${thumbWidth}:${thumbHeight},tile=${columns}x${rows}`,
                    '-frames:v 1',
                    '-q:v 3'  // Quality (1-31, lower = better)
                ])
                .output(spritePath)
                .on('end', async () => {
                    console.log('✅ Sprite generated')

                    // Convert to WebP for smaller size
                    const webpPath = path.join(outputDir, 'sprite.webp')
                    await sharp(spritePath)
                        .webp({ quality: 80 })
                        .toFile(webpPath)

                    // Delete jpg version
                    await fs.unlink(spritePath).catch(() => { })

                    resolve({
                        path: `/thumbnails/${videoId}/sprite.webp`,
                        columns,
                        rows,
                        thumbWidth,
                        thumbHeight,
                        spriteWidth: thumbWidth * columns,
                        spriteHeight: thumbHeight * rows,
                    })
                })
                .on('error', (err) => {
                    console.error('Sprite generation error:', err)
                    reject(err)
                })
                .run()
        })
    }

    // ✅ Get thumbnails from local folder
    async getThumbnails({ params, response }: HttpContext) {
        try {
            const videoId = params.id
            const thumbnailDir = app.publicPath(`thumbnails/${videoId}`)

            try {
                const files = await fs.readdir(thumbnailDir)
                console.log(`🔍 Found ${files.length} files for video ${videoId}`)

                return response.json({
                    success: true,
                    count: files.length,
                    data: files.map(f => `/thumbnails/${videoId}/${f}`),
                })
            } catch (error) {
                return response.status(404).json({
                    success: false,
                    message: 'Video folder not found',
                })
            }
        } catch (error: any) {
            return response.status(500).json({ success: false, message: error.message })
        }
    }

    // ✅ List all processed videos
    async getVideos({ response }: HttpContext) {
        try {
            const thumbnailDir = app.publicPath('thumbnails')

            try {
                const videos = await fs.readdir(thumbnailDir)
                console.log(`📺 Found ${videos.length} processed videos`)

                const videoList = await Promise.all(
                    videos.map(async (videoId) => {
                        const files = await fs.readdir(path.join(thumbnailDir, videoId))
                        return {
                            videoId,
                            fileCount: files.length,
                        }
                    })
                )

                return response.json({
                    success: true,
                    count: videoList.length,
                    data: videoList,
                })
            } catch (error) {
                return response.json({
                    success: true,
                    count: 0,
                    data: [],
                    message: 'No videos processed yet',
                })
            }
        } catch (error: any) {
            return response.status(500).json({ success: false, message: error.message })
        }
    }

    private calculateFrameCount(duration: number): { frameCount: number; interval: number } {
        let frameCount: number
        let interval: number

        if (duration < 60) {
            frameCount = Math.ceil(duration)
            interval = 1
        } else if (duration < 600) {
            frameCount = Math.ceil(duration / 2)
            interval = 2
        } else if (duration < 3600) {
            frameCount = Math.ceil(duration / 5)
            interval = 5
        } else if (duration < 7200) {
            frameCount = Math.ceil(duration / 10)
            interval = 10
        } else {
            frameCount = 500
            interval = duration / 500
        }

        return { frameCount, interval }
    }

    private formatTime(seconds: number): string {
        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const secs = Math.floor(seconds % 60)
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
        }
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }

    private getVideoDuration(videoPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) return reject(err)
                resolve(metadata.format.duration || 0)
            })
        })
    }
}