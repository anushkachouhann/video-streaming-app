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
router.group(() => {
  router.post('/upload', [VideoController, 'uploadVideo'])
  router.get('/videos', [VideoController, 'getVideos'])
  router.get('/videos/:id/thumbnails', [VideoController, 'getThumbnails'])

}).prefix('/api/v1')