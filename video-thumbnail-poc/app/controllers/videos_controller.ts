import type { HttpContext } from '@adonisjs/core/http'
import fs from 'fs/promises'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import app from '@adonisjs/core/services/app'
import os from 'node:os'  // ← add this for safe temp

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

            const customThumbnailFile = request.file('thumbnail')  // Optional custom thumbnail

            // 1. Save video
            const uploadDir = app.publicPath('uploads/videos')
            await fs.mkdir(uploadDir, { recursive: true })
            const fileName = `${Date.now()}-${uuid()}.mp4`
            await videoFile.move(uploadDir, { name: fileName })
            const videoPath = path.join(uploadDir, fileName)
            const videoUrl = `/uploads/videos/${fileName}`  // Frontend ke liye URL
            console.log(`✅ Video saved: ${videoPath}`)

            // 2. Duration
            const duration = await this.getVideoDuration(videoPath)
            console.log(`📹 Duration: ${duration}s (${this.formatTime(duration)})`)
            if (duration <= 0) throw new Error('Invalid video duration')

            // 3. Calculate frames
            const { frameCount, interval } = this.calculateFrameCount(duration)
            console.log(`🎯 Frame Count: ${frameCount} (every ${interval.toFixed(2)}s)`)

            // 4. Safe temp dir
            const tempBase = os.tmpdir()
            const tempDir = path.join(tempBase, `video-frames-${uuid()}`)
            await fs.mkdir(tempDir, { recursive: true })
            console.log(`Temp dir: ${tempDir}`)

            // 5. Extract frames
            await this.extractFramesManual(videoPath, tempDir, frameCount, interval, duration)

            // 6. Read extracted frames
            const frameFiles = (await fs.readdir(tempDir)).filter(f => f.endsWith('.png'))
            frameFiles.sort((a, b) => {
                const numA = parseInt(a.match(/\d+/)?.[0] || '0')
                const numB = parseInt(b.match(/\d+/)?.[0] || '0')
                return numA - numB
            })
            console.log(`📸 Found ${frameFiles.length} frames`)

            // 7. Thumbnails folder
            const videoFolderId = uuid()
            const thumbnailDir = app.publicPath(`thumbnails/${videoFolderId}`)
            await fs.mkdir(thumbnailDir, { recursive: true })

            // 8. Process thumbnails with sharp
            const thumbnails: any[] = []
            for (let i = 0; i < frameFiles.length; i++) {
                const framePath = path.join(tempDir, frameFiles[i])
                const thumbnailFileName = `thumb-${i + 1}.webp`
                const thumbnailPath = path.join(thumbnailDir, thumbnailFileName)

                await sharp(framePath)
                    .resize(640, 360, { fit: 'cover', kernel: 'lanczos3' })
                    .sharpen({ sigma: 0.5 })
                    .webp({ quality: 95, effort: 6 })
                    .toFile(thumbnailPath)

                const timeSecond = Number((i * interval).toFixed(2))
                thumbnails.push({
                    frameNo: i + 1,
                    timeSecond,
                    imagePath: `/thumbnails/${videoFolderId}/${thumbnailFileName}`,
                    timeLabel: this.formatTime(timeSecond),
                })

                console.log(`✅ Thumbnail ${i + 1}/${frameFiles.length}`)
            }

            // 9. Handle custom thumbnail (agar diya to first thumbnail replace kar do)
            let mainThumbnailPath = thumbnails[0]?.imagePath || '';  // Default auto first
            if (customThumbnailFile) {
                const customThumbName = `main-thumb.webp`
                const customThumbPath = path.join(thumbnailDir, customThumbName)
                await customThumbnailFile.move(thumbnailDir, { name: customThumbName })
                mainThumbnailPath = `/thumbnails/${videoFolderId}/${customThumbName}`
                thumbnails.unshift({  // Add as first
                    frameNo: 0,
                    timeSecond: 0,
                    imagePath: mainThumbnailPath,
                    timeLabel: '00:00 (Custom)',
                });
            }

            // 10. Cleanup temp
            for (const file of frameFiles) {
                await fs.unlink(path.join(tempDir, file)).catch(() => { })
            }
            await fs.rmdir(tempDir).catch(() => { })

            return response.json({
                success: true,
                message: 'Video processed successfully',
                data: {
                    videoId: videoFolderId,
                    fileName: videoFile.clientName,
                    videoUrl,  // ← Yeh add kiya frontend ke liye
                    duration,
                    durationFormatted: this.formatTime(duration),
                    thumbnailCount: thumbnails.length,
                    interval,
                    intervalLabel: interval === 1 ? '1 per second' : `every ${interval.toFixed(2)}s`,
                    mainThumbnail: mainThumbnailPath,
                    thumbnails,
                },
            })
        } catch (error: any) {
            console.error('❌ Error:', error)
            return response.status(500).json({ success: false, message: error.message })
        }
    }

    // New manual extraction method (replaces old one)
    private extractFramesManual(
        videoPath: string,
        outputDir: string,
        count: number,
        interval: number,
        duration: number
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let completed = 0

            for (let i = 0; i < count; i++) {
                const time = Math.min(i * interval, duration - 0.1) // avoid end overflow
                const outputFile = path.join(outputDir, `frame-${(i + 1).toString().padStart(3, '0')}.png`)

                ffmpeg(videoPath)
                    .seekInput(time)
                    .outputOptions([
                        '-vframes 1',
                        '-sws_flags lanczos',
                        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'
                    ])
                    .output(outputFile)
                    .on('end', () => {
                        completed++
                        if (completed === count) {
                            console.log('✅ All frames extracted')
                            resolve()
                        }
                    })
                    .on('error', (err) => {
                        console.error(`Frame ${i + 1} error:`, err)
                        reject(err)
                    })
                    .run()
            }
        })
    }

    // ✅ Get thumbnails from local folder
    async getThumbnails({ params, response }: HttpContext) {
        try {
            const videoId = params.id

            // Check if thumbnail folder exists
            const thumbnailDir = app.publicPath(`thumbnails/${videoId}`)

            try {
                const files = await fs.readdir(thumbnailDir)
                console.log(`📁 Found ${files.length} thumbnails for video ${videoId}`)

                if (files.length === 0) {
                    return response.status(404).json({
                        success: false,
                        message: 'No thumbnails found for this video',
                    })
                }

                // Sort by frame number
                files.sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/)?.[0] || '0')
                    const numB = parseInt(b.match(/\d+/)?.[0] || '0')
                    return numA - numB
                })

                // Calculate approximate time for each frame
                // You'd need to store this info for accurate display
                const thumbnails = files.map((file, index) => ({
                    frameNo: index + 1,
                    imagePath: `/thumbnails/${videoId}/${file}`,
                }))

                return response.json({
                    success: true,
                    count: thumbnails.length,
                    data: thumbnails,
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

    // ✅ List all processed videos (folders)
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
                            thumbnailCount: files.length,
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
        // your existing logic
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
    // ✅ Format time (HH:MM:SS)
    private formatTime(seconds: number): string {
        // your existing
        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const secs = Math.floor(seconds % 60)
        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
        }
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }

    // Helper: Get video duration
    private getVideoDuration(videoPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) return reject(err)
                resolve(metadata.format.duration || 0)
            })
        })
    }
    // Helper: Extract frames
    private extractFrames(
        videoPath: string,
        outputDir: string,
        count: number
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .screenshots({
                    count: count,
                    folder: outputDir,
                    filename: 'frame-%i.png',
                    size: '1280x720',  // ↑ badhao
                })
                .outputOptions([
                    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',  // aspect ratio safe
                    '-sws_flags', 'lanczos'   // ← yeh sharp banayega
                ])
        })
    }
} 