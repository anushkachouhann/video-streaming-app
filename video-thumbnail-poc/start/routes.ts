/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
const VideoController = () => import('#controllers/videos_controller')

router.get('/', async () => {
  return {
    hello: 'world',
  }
})



router.post('/api/v1/upload', [VideoController, 'uploadVideo'])
router.get('/api/v1/videos', [VideoController, 'getVideos'])
router.get('/api/v1/videos/:id/thumbnails', [VideoController, 'getThumbnails'])